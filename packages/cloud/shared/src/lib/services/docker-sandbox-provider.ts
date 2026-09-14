/**
 * DockerSandboxProvider — SandboxProvider implementation for Docker containers
 * on remote VPS nodes.
 *
 * Manages the full lifecycle: create (pull image + docker run), stop/remove,
 * health-check, and arbitrary command execution inside containers.
 *
 * Reference: eliza-cloud/backend/services/container-orchestrator.ts
 */

import { ElizaError } from "@elizaos/core";
import { buildDefaultElizaCloudServiceRouting } from "@elizaos/shared/contracts/service-routing";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { WARM_POOL_ORG_ID } from "../../db/schemas/agent-sandboxes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import { isAgentTokenSigningConfigured, mintAgentToken } from "../auth/agent-token";
import { containersEnv } from "../config/containers-env";
import { getAgentBaseDomain } from "../eliza-agent-web-ui";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { signStewardMutatingRequest } from "../steward/sign";
import { resolveServerStewardApiUrlFromEnv } from "../steward-url";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/with-timeout";
import {
  AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
  deriveRestoreStagingVolumePathV1,
} from "./agent-backup-restore-vault-seed";
import {
  agentCpuUnitsToDockerCpus,
  buildAgentContainerCpuFlags,
  buildAgentContainerMemoryFlags,
  buildAgentContainerSecurityFlags,
} from "./agent-container-security";
import { ensureRegistryAccess, getImageRegistryHost } from "./containers/hetzner-client/registry";
import { getNodeAutoscaler } from "./containers/node-autoscaler";
import { resolveImageDigest } from "./containers/registry-probe";
import {
  isAlreadyGoneMessage,
  isContainerAbsentMessage,
  isNodeUnreachableMessage,
} from "./docker-error-classifier";
import {
  buildDockerLiveRestoreProofCommand,
  clearPlacementCommandFailures,
  dockerNodeManager,
  isDockerSshCommandTimeoutError,
  notePlacementCommandFailure,
} from "./docker-node-manager";
import { getUsedDockerHostPorts } from "./docker-port-allocation";
import {
  allocatePort,
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  buildAgentContainerLabelFlags,
  buildDockerContainerEnvTransport,
  buildDockerCreateWithSecretEnvCommand,
  buildEnsureNetworkCmd,
  buildExactRestoreStagingVolumeCleanupCommand,
  buildReplacementCandidateObservedCommand,
  buildReplacementCreatedContainerIdProofCommand,
  buildReplacementSecretArtifactsCleanupCommand,
  CONTAINER_DURABLE_STATE_DIR,
  dockerPlatformFlag,
  ensureVolumeVaultPassphrase,
  extractDockerCreateContainerId,
  getContainerName,
  getContainerSecretEnvPath,
  getExactRestoreStagingVolumeCleanupReceipt,
  getReplacementCandidateObservedReceipt,
  getReplacementControlSecretEnvPath,
  getReplacementControlVaultPassphrasePath,
  getReplacementDockerCreateQuiescentReceipt,
  getReplacementSecretArtifactsCleanupReceipt,
  getVolumePath,
  getVolumeVaultPassphrasePath,
  inferNodeArchitectureFromMetadata,
  parseDockerNodes,
  requiresDockerHostGateway,
  resolveAgentContainerClass,
  resolveStewardContainerUrl,
  resolveVpnTeardown,
  shellQuote,
  validateAgentId,
  validateAgentName,
  validateContainerName,
  validateEnvKey,
  validateEnvValue,
  validateVolumePath,
  WEBUI_PORT_MAX,
  WEBUI_PORT_MIN,
} from "./docker-sandbox-utils";
import { classifyDockerSshProbeError, DockerSSHClient } from "./docker-ssh";
import {
  classifyMeshAuthStatus,
  TS_AUTHKEY_EXPIRED_EXIT_CODE,
  TS_AUTHKEY_EXPIRED_MARKER_BASENAME,
} from "./headscale-auth-status";
import { headscaleClient } from "./headscale-client";
import {
  assertCanonicalHeadscaleNode,
  DEFAULT_REGISTRATION_TIMEOUT_MS,
  headscaleIntegration,
  isCanonicalHeadscaleNodeId,
  isCanonicalHeadscaleTailnetIpv4,
} from "./headscale-integration";
import { buildKeylessOpenAIContainerEnv } from "./managed-eliza-env";
import { applyRemoteDockerRuntimeMode } from "./remote-docker-runtime-mode";
import type {
  SandboxCreateConfig,
  SandboxDeletionLocator,
  SandboxDeletionStopOutcome,
  SandboxExactRestoreCreateConfig,
  SandboxExactRestoreTarget,
  SandboxHandle,
  SandboxHealthContext,
  SandboxHealthOutcome,
  SandboxProvider,
  SandboxReplacementCleanupLocator,
} from "./sandbox-provider-types";
import {
  assertContainerBackedExecutionTier,
  assertSandboxReplacementAttemptId,
  SandboxReplacementCleanupUnresolvedError,
  SandboxReplacementCreateSettlementCleanupUnresolvedError,
} from "./sandbox-provider-types";
import {
  ensureStewardTenant,
  resolveStewardTenantCredentials,
  type StewardTenantCredentials,
} from "./steward-tenant-config";
import { tailnetPathMonitor } from "./tailnet-path-monitor";

// ---------------------------------------------------------------------------
// Exported metadata type for strongly-typed provider metadata
// ---------------------------------------------------------------------------

/** Typed metadata returned by DockerSandboxProvider in SandboxHandle.metadata */
export interface DockerSandboxMetadata {
  provider: "docker";
  nodeId: string;
  hostname: string;
  /** Exact DB record + SSH authority used by replacement cleanup. */
  nodeRecordId?: string;
  /** Exact Linux boot and history occurrence for restore materialization. */
  nodeIncarnation?: string;
  nodeHistoryId?: string;
  nodeSshPort?: number;
  nodeSshUser?: string;
  nodeHostKeyFingerprint?: string;
  replacementSecretCleanupVersion?: 1;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  volumePath: string;
  dockerImage: string;
  /**
   * Registry-resolved sha256 digest of `dockerImage` at provision time.
   * Null when the image is not on a supported registry (e.g. a local-only
   * name) or the registry was unreachable. The fleet-upgrade reconciler
   * uses this to detect when the tag's digest has moved.
   */
  imageDigest: string | null;
  /** Exact restore manifest-list/generation reference retained for audit. */
  imageIndexReference?: string;
  /** Registry-verified child manifest actually materialized. */
  imagePlatformDigest?: string;
  /** Canonical runtime platform bound to the reserved node occurrence. */
  imagePlatform?: "linux/amd64" | "linux/arm64";
  headscaleIp?: string;
  /** Exact Headscale identity for strict replacement cleanup. */
  vpnNodeId?: string;
  /** Deterministic Headscale name used to recover a pre-enrichment crash. */
  vpnNodeName?: string;
  /** Lower bound for identifying this attempt's Headscale registration. */
  vpnRegistrationStartedAt?: string;
  /** Unique Docker label binding this candidate to its durable intent. */
  replacementAttemptId: string;
  /** Restore generation for a stopped, unroutable quarantine candidate. */
  restoreAttemptId?: string;
  quarantine?: true;
  /** Exact Docker id after create responds; absent on the pre-create intent. */
  containerId?: string;
  /** Whether this placement reserved docker_nodes.allocated_count. */
  allocationCounted: boolean;
  /** Preserved live node id from a reclaimStaleVpnNode=false provision
   *  (#16565) — the upgrade orchestrator deletes it BY ID after the atomic
   *  swap; rolled-back paths must leave it untouched. */
  previousVpnNodeId?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ContainerMeta {
  nodeId: string;
  hostname: string;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  /** Headscale node name (TS_HOSTNAME) used at registration, for cleanup lookup. */
  tsHostname?: string;
  /** THIS container's registered Headscale node id (#16565): the only safe
   *  teardown identifier while a blue/green overlap shares the hostname. */
  vpnNodeId?: string;
  /** The preserved live node's id when created with reclaimStaleVpnNode=false
   *  (#16565); the upgrade orchestrator deletes it by id after cutover. */
  previousVpnNodeId?: string;
  sshPort: number;
  sshUser: string;
  hostKeyFingerprint?: string;
}

type TeardownContainerMeta = Omit<ContainerMeta, "bridgePort" | "webUiPort">;

interface RemoteCompletionTracker {
  readonly causes: unknown[];
}

type DockerNodeConnection = Pick<
  DockerNode,
  "node_id" | "hostname" | "ssh_port" | "ssh_user" | "host_key_fingerprint"
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOCKER_IMAGE_OVERRIDE = containersEnv.defaultAgentImageOverride();
const DOCKER_NETWORK = containersEnv.dockerNetwork();
let hasWarnedMissingStewardTenantApiKey = false;

const DEFAULT_AGENT_PORT = containersEnv.agentPort();
const DEFAULT_BRIDGE_PORT = containersEnv.agentBridgePort();
const REPLACEMENT_ATTEMPT_LABEL = "ai.elizaos.replacement-attempt";
const EXACT_RESTORE_ATTEMPT_LABEL = "ai.elizaos.restore-attempt-id";
const EXACT_RESTORE_NODE_RECORD_LABEL = "ai.elizaos.restore-node-record-id";
const EXACT_RESTORE_NODE_INCARNATION_LABEL = "ai.elizaos.restore-node-incarnation";
const EXACT_RESTORE_NODE_HISTORY_LABEL = "ai.elizaos.restore-node-history-id";
const EXACT_RESTORE_IMAGE_DIGEST_LABEL = "ai.elizaos.restore-image-digest";
const EXACT_RESTORE_QUARANTINE_LABEL = "ai.elizaos.restore-quarantine";
const REMOTE_NODE_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const EXACT_RESTORE_REMOTE_BOOT_FENCE_EXIT_CODE = 78;
const REPLACEMENT_VPN_SETTLE_OBSERVATIONS = 4;
const REPLACEMENT_VPN_SETTLE_INTERVAL_MS = 750;
const REPLACEMENT_VPN_CLOCK_SKEW_ALLOWANCE_MS = 30_000;
const REPLACEMENT_VPN_MAX_RECOVERABLE_REGISTRATIONS = 32;
// Converge window for an id-verified container whose attempt label drifted
// from the fence record (#18032): the immutable Docker id plus a matching
// deterministic name identify the fenced target beyond doubt, but a young
// container is still retained in case a concurrent lifecycle op is mid-write.
const REPLACEMENT_LABEL_MISMATCH_RETIRE_GRACE_MS = 60 * 60 * 1000;

class ReplacementPlacementPersistenceError extends Error {
  constructor(cause: unknown) {
    super("[docker-sandbox] Failed to persist replacement placement", {
      cause,
    });
    this.name = "ReplacementPlacementPersistenceError";
  }
}

/** Keeps the durable cleanup intent on the happens-before side of Docker create. */
export async function createDockerContainerAfterReplacementIntent<T>({
  persistIntent,
  createContainer,
}: {
  persistIntent?: () => Promise<void>;
  createContainer: () => Promise<T>;
}): Promise<T> {
  if (persistIntent) {
    await persistIntent();
  }
  return createContainer();
}

function optionalLocatorString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalLocatorNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCanonicalNodeAuthorityUuid(value: string | null | undefined): value is string {
  return Boolean(
    value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
  );
}

function exactRestoreContainerName(agentId: string, restoreAttemptId: string): string {
  validateAgentId(agentId);
  assertSandboxReplacementAttemptId(restoreAttemptId);
  const containerName = `agent-restore-${agentId}-${restoreAttemptId}`;
  validateContainerName(containerName);
  return containerName;
}

function exactRestoreVolumePath(agentId: string, restoreAttemptId: string): string {
  const volumePath = deriveRestoreStagingVolumePathV1(agentId, restoreAttemptId);
  validateVolumePath(volumePath);
  return volumePath;
}

function exactRestoreVolumePathFromCleanupLocator(
  locator: SandboxReplacementCleanupLocator,
): string | undefined {
  const restoreAttemptId = locator.restoreAttemptId ?? null;
  if (restoreAttemptId === null) return undefined;
  const prefix = "agent-restore-";
  const suffix = `-${restoreAttemptId}`;
  if (!locator.containerName.startsWith(prefix) || !locator.containerName.endsWith(suffix)) {
    throw new ElizaError("Exact restore cleanup locator has a non-canonical container name", {
      code: "SANDBOX_EXACT_RESTORE_CLEANUP_LOCATOR_INVALID",
      context: { containerName: locator.containerName, restoreAttemptId },
      severity: "fatal",
    });
  }
  const agentId = locator.containerName.slice(prefix.length, -suffix.length);
  return exactRestoreVolumePath(agentId, restoreAttemptId);
}

function freezeExactRestoreTarget(target: SandboxExactRestoreTarget): SandboxExactRestoreTarget {
  if (
    !target ||
    !isCanonicalNodeAuthorityUuid(target.nodeRecordId) ||
    typeof target.nodeId !== "string" ||
    target.nodeId.length === 0 ||
    target.nodeId !== target.nodeId.trim() ||
    !isCanonicalNodeAuthorityUuid(target.nodeIncarnation) ||
    !isCanonicalNodeAuthorityUuid(target.nodeHistoryId) ||
    (target.platform !== "linux/amd64" && target.platform !== "linux/arm64")
  ) {
    throw new ElizaError("Exact restore target must identify one canonical node occurrence", {
      code: "SANDBOX_EXACT_RESTORE_TARGET_INVALID",
      context: {
        nodeRecordId:
          target && typeof target.nodeRecordId === "string" ? target.nodeRecordId : null,
        nodeId: target && typeof target.nodeId === "string" ? target.nodeId : null,
      },
      severity: "fatal",
    });
  }
  return Object.freeze({
    nodeRecordId: target.nodeRecordId,
    nodeId: target.nodeId,
    nodeIncarnation: target.nodeIncarnation,
    nodeHistoryId: target.nodeHistoryId,
    platform: target.platform,
  });
}

function freezeExactRestoreConfig(
  exactRestore: SandboxExactRestoreCreateConfig,
): SandboxExactRestoreCreateConfig {
  const target = freezeExactRestoreTarget(exactRestore.target);
  assertSandboxReplacementAttemptId(exactRestore.restoreAttemptId);
  if (exactRestore.quarantine !== true) {
    throw new ElizaError("Exact restore creation requires explicit quarantine", {
      code: "SANDBOX_EXACT_RESTORE_QUARANTINE_REQUIRED",
      severity: "fatal",
    });
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(exactRestore.imageDigest)) {
    throw new ElizaError("Exact restore image digest must be a canonical sha256 digest", {
      code: "SANDBOX_EXACT_RESTORE_IMAGE_DIGEST_INVALID",
      severity: "fatal",
    });
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(exactRestore.imagePlatformDigest)) {
    throw new ElizaError("Exact restore platform image digest must be a canonical sha256 digest", {
      code: "SANDBOX_EXACT_RESTORE_IMAGE_PLATFORM_DIGEST_INVALID",
      severity: "fatal",
    });
  }
  const digestSeparator = exactRestore.imageReference.indexOf("@");
  const imageName = exactRestore.imageReference.slice(0, digestSeparator);
  if (
    digestSeparator <= 0 ||
    digestSeparator !== exactRestore.imageReference.lastIndexOf("@") ||
    imageName !== imageName.toLowerCase() ||
    !imageName.includes("/") ||
    getImageRegistryHost(exactRestore.imageReference) === null ||
    /\s/.test(exactRestore.imageReference) ||
    exactRestore.imageReference.slice(digestSeparator + 1) !== exactRestore.imageDigest
  ) {
    throw new ElizaError("Exact restore image reference must pin the manifest digest", {
      code: "SANDBOX_EXACT_RESTORE_IMAGE_REFERENCE_INVALID",
      severity: "fatal",
    });
  }
  return Object.freeze({
    restoreAttemptId: exactRestore.restoreAttemptId,
    target,
    imageReference: exactRestore.imageReference,
    imageDigest: exactRestore.imageDigest,
    imagePlatformDigest: exactRestore.imagePlatformDigest,
    quarantine: true,
  });
}

function isExactRestoreContainerName(value: string): boolean {
  const match = /^agent-restore-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(value);
  if (!match) return false;
  try {
    return exactRestoreContainerName(match[1]!, match[2]!) === value;
  } catch {
    // error-policy:J3 canonical validation translates rejected input to false.
    return false;
  }
}

export function buildExactRestoreBootFencedCommand(
  expectedNodeIncarnation: string,
  exactCommand: string,
): string {
  return [
    `observed_boot_id=$(cat ${shellQuote(REMOTE_NODE_BOOT_ID_PATH)} 2>/dev/null) || { printf '%s\\n' 'ELIZA_RESTORE_BOOT_ID_UNREADABLE' >&2; exit ${EXACT_RESTORE_REMOTE_BOOT_FENCE_EXIT_CODE}; }`,
    `if [ "$observed_boot_id" != ${shellQuote(expectedNodeIncarnation)} ]; then printf '%s\\n' 'ELIZA_RESTORE_BOOT_ID_MISMATCH' >&2; exit ${EXACT_RESTORE_REMOTE_BOOT_FENCE_EXIT_CODE}; fi`,
    exactCommand,
  ].join("; ");
}

/** Boot-fence and isolate every exact Docker CLI call from ambient client state. */
export function buildExactRestoreDockerBootFencedCommand(
  expectedNodeIncarnation: string,
  exactDockerCommand: string,
): string {
  const configTemplate = "/tmp/eliza-exact-docker.XXXXXXXXXX";
  const cleanup =
    "cleanup_exact_docker_config() { cleanup_status=$?; trap - EXIT; " +
    'case "$exact_docker_config" in /tmp/eliza-exact-docker.?*) ' +
    'rm -rf -- "$exact_docker_config" || cleanup_status=70 ;; *) cleanup_status=70 ;; esac; ' +
    'exit "$cleanup_status"; }';
  const isolatedCommand = [
    "set -eu",
    "umask 077",
    `exact_docker_config=$(mktemp -d ${shellQuote(configTemplate)})`,
    cleanup,
    "trap cleanup_exact_docker_config EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'chmod 700 -- "$exact_docker_config"',
    `printf '%s\\n' ${shellQuote('{"auths":{},"proxies":{}}')} > "$exact_docker_config/config.json"`,
    'chmod 600 -- "$exact_docker_config/config.json"',
    "unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_DEFAULT_PLATFORM DOCKER_API_VERSION",
    'DOCKER_HOST="unix:///var/run/docker.sock"',
    'DOCKER_CONFIG="$exact_docker_config"',
    "export DOCKER_HOST DOCKER_CONFIG",
    'docker() { command docker --host unix:///var/run/docker.sock --config "$exact_docker_config" "$@"; }',
    `(${exactDockerCommand})`,
  ].join("; ");
  return buildExactRestoreBootFencedCommand(expectedNodeIncarnation, isolatedCommand);
}

function buildExactRestoreAnonymousPullCommand(
  imageReference: string,
  platform: "linux/amd64" | "linux/arm64",
): string {
  return ["docker pull", ...dockerPlatformFlag(platform), shellQuote(imageReference)].join(" ");
}

const EXACT_RESTORE_MANIFEST_DESCRIPTOR_MINIMUM_API_MINOR = 48;
const CONTAINERD_SNAPSHOTTER_DRIVER = "io.containerd.snapshotter.v1";

function assertExactRestoreManifestProofCapability(
  proof: string,
  nodeId: string,
  replacementAttemptId: string,
): void {
  const lines = proof
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const [clientApiVersion = "", serverApiVersion = "", ...unexpectedApiFields] = (
    lines[0] ?? ""
  ).split("|");
  const supportsManifestDescriptor = (apiVersion: string): boolean => {
    const apiMatch = /^(\d+)\.(\d+)$/.exec(apiVersion);
    return Boolean(
      apiMatch &&
        (Number(apiMatch[1]) > 1 ||
          (Number(apiMatch[1]) === 1 &&
            Number(apiMatch[2]) >= EXACT_RESTORE_MANIFEST_DESCRIPTOR_MINIMUM_API_MINOR)),
    );
  };
  const apiSupportsManifestDescriptor =
    unexpectedApiFields.length === 0 &&
    supportsManifestDescriptor(clientApiVersion) &&
    supportsManifestDescriptor(serverApiVersion);
  let driverStatus: unknown = null;
  try {
    driverStatus = JSON.parse(lines[1] ?? "null");
  } catch {
    // error-policy:J3 malformed daemon capability output must fail closed.
  }
  const hasContainerdImageStore =
    Array.isArray(driverStatus) &&
    driverStatus.some(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry[0] === "driver-type" &&
        entry[1] === CONTAINERD_SNAPSHOTTER_DRIVER,
    );
  if (lines.length !== 2 || !apiSupportsManifestDescriptor || !hasContainerdImageStore) {
    throw new ElizaError(
      "Exact restore target cannot prove the container-bound platform manifest",
      {
        code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_UNSUPPORTED",
        context: {
          nodeId,
          replacementAttemptId,
          dockerClientApiVersion: clientApiVersion || null,
          dockerServerApiVersion: serverApiVersion || null,
          containerdImageStore: hasContainerdImageStore,
        },
        severity: "fatal",
      },
    );
  }
}

function buildExactRestorePreseedProofCommand(volumePath: string): string {
  validateVolumePath(volumePath);
  const elizaPath = `${volumePath}/eliza`;
  const vaultPassphrasePath = getVolumeVaultPassphrasePath(volumePath);
  const volume = shellQuote(volumePath);
  const eliza = shellQuote(elizaPath);
  const vaultPassphrase = shellQuote(vaultPassphrasePath);
  return [
    "set -eu",
    `test ! -L ${volume} && test -d ${volume}`,
    `test ! -L ${eliza} && test -d ${eliza}`,
    `test ! -L ${vaultPassphrase} && test -f ${vaultPassphrase}`,
    `test "$(stat -c '%a' ${vaultPassphrase})" = '600'`,
    `vault_length=$(wc -c < ${vaultPassphrase} | tr -d ' ')`,
    `test "$vault_length" = '${AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES}'`,
  ].join("; ");
}

function extractExactRestoreDockerContainerId(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !/^[0-9a-f]{64}$/.test(lines[0] ?? "")) {
    throw new ElizaError("Exact restore Docker create did not produce one full container ID", {
      code: "SANDBOX_EXACT_RESTORE_CONTAINER_ID_INVALID",
      severity: "fatal",
    });
  }
  return lines[0]!;
}

const EXACT_RESTORE_FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
  "AGENT_SERVER_SHARED_SECRET",
  "KV_REST_API_TOKEN",
  "KV_REST_API_URL",
  "ELIZA_CLOUD_PUBLIC_URL",
  "ORCHESTRATOR_SESSION_ID",
  "PUBLIC_URL",
  "SANDBOX_AGENT_ID",
  "SANDBOX_PUBLIC_URL",
  "SANDBOX_ROUTE_AGENT_ID",
  "SANDBOX_SERVER_NAME",
]);

const EXACT_RESTORE_FORBIDDEN_ENVIRONMENT_PREFIXES = [
  "AGENT_ROUTER_",
  "ELIZA_STEWARD_",
  "HEADSCALE_",
  "STEWARD_",
  "TAILSCALE_",
  "TS_",
] as const;

function exactRestoreEnvironment(
  environmentVars: Readonly<Record<string, string>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(environmentVars)) {
    const normalizedKey = key.trim().toUpperCase();
    if (
      EXACT_RESTORE_FORBIDDEN_ENVIRONMENT_KEYS.has(normalizedKey) ||
      normalizedKey.startsWith("SANDBOX_") ||
      EXACT_RESTORE_FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) =>
        normalizedKey.startsWith(prefix),
      )
    ) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

function isCanonicalReplacementContainerName(value: string): boolean {
  if (isExactRestoreContainerName(value)) return true;
  if (!value.startsWith("agent-")) return false;
  try {
    return getContainerName(value.slice("agent-".length)) === value;
  } catch {
    // error-policy:J3 canonical validation translates rejected input to false.
    return false;
  }
}

function replacementCleanupLocatorFromHandle(
  handle: SandboxHandle,
): SandboxReplacementCleanupLocator | null {
  const metadata = handle.metadata;
  if (
    typeof handle.sandboxId !== "string" ||
    !metadata ||
    typeof metadata.nodeId !== "string" ||
    typeof metadata.containerName !== "string" ||
    typeof metadata.replacementAttemptId !== "string"
  ) {
    return null;
  }
  return {
    sandboxId: handle.sandboxId,
    nodeId: metadata.nodeId,
    containerName: metadata.containerName,
    nodeRecordId: optionalLocatorString(metadata.nodeRecordId),
    nodeIncarnation: optionalLocatorString(metadata.nodeIncarnation),
    nodeHistoryId: optionalLocatorString(metadata.nodeHistoryId),
    nodeHostname: optionalLocatorString(metadata.hostname),
    nodeSshPort: optionalLocatorNumber(metadata.nodeSshPort),
    nodeSshUser: optionalLocatorString(metadata.nodeSshUser),
    nodeHostKeyFingerprint: optionalLocatorString(metadata.nodeHostKeyFingerprint),
    replacementSecretCleanupVersion: metadata.replacementSecretCleanupVersion === 1 ? 1 : null,
    replacementAttemptId: metadata.replacementAttemptId,
    restoreAttemptId: optionalLocatorString(metadata.restoreAttemptId),
    containerId: optionalLocatorString(metadata.containerId),
    vpnNodeId: optionalLocatorString(metadata.vpnNodeId),
    vpnNodeName: optionalLocatorString(metadata.vpnNodeName),
    previousVpnNodeId: optionalLocatorString(metadata.previousVpnNodeId),
    vpnRegistrationStartedAt: optionalLocatorString(metadata.vpnRegistrationStartedAt),
    allocationCounted:
      typeof metadata.allocationCounted === "boolean" ? metadata.allocationCounted : null,
  };
}

function dockerContainerIdsMatch(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{12,64}$/i.test(expected) || !/^[a-f0-9]{12,64}$/i.test(actual)) {
    return false;
  }
  return expected.startsWith(actual) || actual.startsWith(expected);
}

function isCanonicalDockerContainerId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{12,64}$/.test(value);
}

function isCanonicalReplacementLocatorCore(
  locator: SandboxReplacementCleanupLocator,
  expectedReplacementAttemptId?: string,
): boolean {
  const vpnNodeName = locator.vpnNodeName ?? null;
  const vpnRegistrationStartedAt = locator.vpnRegistrationStartedAt ?? null;
  const vpnNodeId = locator.vpnNodeId ?? null;
  const previousVpnNodeId = locator.previousVpnNodeId ?? null;
  const containerId = locator.containerId ?? null;

  return (
    locator.sandboxId.trim().length > 0 &&
    locator.sandboxId === locator.containerName &&
    locator.nodeId.trim().length > 0 &&
    locator.containerName.trim().length > 0 &&
    typeof locator.replacementAttemptId === "string" &&
    (expectedReplacementAttemptId === undefined ||
      locator.replacementAttemptId === expectedReplacementAttemptId) &&
    typeof locator.allocationCounted === "boolean" &&
    (containerId === null || isCanonicalDockerContainerId(containerId)) &&
    (vpnNodeName === null) === (vpnRegistrationStartedAt === null) &&
    (vpnNodeName === null || vpnNodeName.trim().length > 0) &&
    (vpnRegistrationStartedAt === null || Number.isFinite(Date.parse(vpnRegistrationStartedAt))) &&
    (previousVpnNodeId === null ||
      (vpnNodeName !== null && isCanonicalHeadscaleNodeId(previousVpnNodeId))) &&
    (vpnNodeId === null || isCanonicalHeadscaleNodeId(vpnNodeId)) &&
    (vpnNodeId === null || vpnNodeId !== previousVpnNodeId)
  );
}

function isCanonicalExactReplacementLocator(
  locator: SandboxReplacementCleanupLocator,
  expected?: { readonly containerName?: string; readonly replacementAttemptId?: string },
): boolean {
  const vpnNodeName = locator.vpnNodeName ?? null;
  const vpnRegistrationStartedAt = locator.vpnRegistrationStartedAt ?? null;
  const vpnNodeId = locator.vpnNodeId ?? null;
  const previousVpnNodeId = locator.previousVpnNodeId ?? null;
  const containerId = locator.containerId ?? null;
  const hasVpnRegistrationPair = vpnNodeName !== null && vpnRegistrationStartedAt !== null;
  const restoreAttemptId = locator.restoreAttemptId ?? null;
  const isRestoreLocator = restoreAttemptId !== null;

  return (
    isCanonicalReplacementLocatorCore(locator, expected?.replacementAttemptId) &&
    isCanonicalReplacementContainerName(locator.containerName) &&
    (expected?.containerName === undefined || locator.containerName === expected.containerName) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      locator.replacementAttemptId ?? "",
    ) &&
    isCanonicalNodeAuthorityUuid(locator.nodeRecordId) &&
    Boolean(locator.nodeHostname?.trim()) &&
    typeof locator.nodeSshPort === "number" &&
    Number.isSafeInteger(locator.nodeSshPort) &&
    locator.nodeSshPort >= 1 &&
    locator.nodeSshPort <= 65_535 &&
    Boolean(locator.nodeSshUser?.trim()) &&
    Boolean(locator.nodeHostKeyFingerprint?.trim()) &&
    (isRestoreLocator
      ? assertCanonicalRestoreLocatorIdentity(locator, restoreAttemptId)
      : locator.replacementSecretCleanupVersion === 1) &&
    locator.allocationCounted === true &&
    (previousVpnNodeId === null || hasVpnRegistrationPair) &&
    (vpnNodeId === null ||
      (containerId !== null && hasVpnRegistrationPair && vpnNodeId !== previousVpnNodeId))
  );
}

function assertCanonicalRestoreLocatorIdentity(
  locator: SandboxReplacementCleanupLocator,
  restoreAttemptId: string,
): boolean {
  try {
    assertSandboxReplacementAttemptId(restoreAttemptId);
  } catch {
    // error-policy:J3 canonical validation translates rejected input to false.
    return false;
  }
  return (
    isExactRestoreContainerName(locator.containerName) &&
    locator.containerName.endsWith(`-${restoreAttemptId}`) &&
    isCanonicalNodeAuthorityUuid(locator.nodeIncarnation) &&
    isCanonicalNodeAuthorityUuid(locator.nodeHistoryId) &&
    locator.replacementSecretCleanupVersion === 1 &&
    (locator.vpnNodeId ?? null) === null &&
    (locator.vpnNodeName ?? null) === null &&
    (locator.previousVpnNodeId ?? null) === null &&
    (locator.vpnRegistrationStartedAt ?? null) === null
  );
}

/** Default SSH port when not specified by DB node record. */
const DEFAULT_SSH_PORT = 22;

/** Default SSH user when not specified by DB node record. */
const DEFAULT_SSH_USERNAME = containersEnv.sshUser();

function resolveStewardHostUrl(): string {
  return resolveServerStewardApiUrlFromEnv(getCloudAwareEnv());
}

function resolveStewardContainerEnvUrl(): string {
  const env = getCloudAwareEnv();
  return resolveStewardContainerUrl(resolveStewardHostUrl(), env.STEWARD_CONTAINER_URL);
}

const STEWARD_JWT_FILE = "/app/data/steward.jwt";
const STEWARD_REFRESH_SERVICE_TOKEN_FILE = "/tmp/eliza-steward-refresh-service-token";
const STEWARD_REFRESH_AUTH_HEADER_FILE = "/tmp/eliza-steward-refresh-authorization.header";
const MAX_STEWARD_REFRESH_SERVICE_TOKEN_BYTES = 8 * 1024;
const MAX_MANAGED_ELIZA_RUNTIME_CONFIG_BYTES = 256 * 1024;
const STEWARD_SSH_STDIN_FRAME_VERSION = "ELIZA_STEWARD_SSH_STDIN_V1";
const STEWARD_SSH_STDIN_FRAME_END = "ELIZA_STEWARD_SSH_STDIN_END";
const MAX_STEWARD_SSH_STDIN_PAYLOAD_BYTES = 256 * 1024;
const MAX_STEWARD_SSH_STDIN_BASE64_BYTES = Math.ceil(MAX_STEWARD_SSH_STDIN_PAYLOAD_BYTES / 3) * 4;

type StewardSshStdinPurpose = "steward-agent-delete" | "steward-agent-register";

/** A static remote command paired with sensitive bytes transported only on stdin. */
export interface StewardSshStdinRequest {
  command: string;
  input: string;
}

type ManagedElizaRuntimeConfigTarget =
  | { kind: "container"; containerName: string }
  | { kind: "host-volume"; volumePath: string };

function buildAtomicStdinFileWriteScript(
  directory: string,
  destination: string,
  options: { mode?: "0600" | "0644"; preserveExistingMetadata?: boolean } = {},
): string {
  const mode = options.mode ?? "0600";
  const prepareTemporaryFile = options.preserveExistingMetadata
    ? [
        // Preserve an existing runtime-owned inode's uid/gid/mode. For the first
        // pre-seed, 0644 retains the historical readability needed before the
        // image entrypoint drops from root to `agent`.
        `if test -e "$destination"; then cp -p "$destination" "$temporary_file"; else : > "$temporary_file"; chmod ${mode} "$temporary_file"; fi`,
      ]
    : [': > "$temporary_file"', `chmod ${mode} "$temporary_file"`];
  return [
    "set -eu",
    "umask 077",
    `destination=${shellQuote(destination)}`,
    'temporary_file="${destination}.tmp.$$"',
    "trap 'rm -f \"$temporary_file\"' EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `mkdir -p ${shellQuote(directory)}`,
    ...prepareTemporaryFile,
    'cat > "$temporary_file"',
    'mv -f "$temporary_file" "$destination"',
    "trap - EXIT HUP INT TERM",
  ].join("; ");
}

function serializeManagedElizaRuntimeConfig(allEnv: Record<string, string | undefined>): string {
  const serialized = JSON.stringify(buildManagedElizaRuntimeConfig(allEnv));
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  if (payloadBytes === 0 || payloadBytes > MAX_MANAGED_ELIZA_RUNTIME_CONFIG_BYTES) {
    throw new Error("[docker-sandbox] Invalid managed eliza.json stdin payload size");
  }
  return serialized;
}

function buildManagedElizaRuntimeConfigWriteRequest(
  target: ManagedElizaRuntimeConfigTarget,
  allEnv: Record<string, string | undefined>,
): StewardSshStdinRequest {
  const input = serializeManagedElizaRuntimeConfig(allEnv);
  if (target.kind === "host-volume") {
    const directory = `${target.volumePath}/eliza`;
    return {
      command: buildAtomicStdinFileWriteScript(directory, `${directory}/eliza.json`, {
        mode: "0644",
        preserveExistingMetadata: true,
      }),
      input,
    };
  }

  const writeScript = buildAtomicStdinFileWriteScript("/root/.eliza", "/root/.eliza/eliza.json", {
    mode: "0644",
    preserveExistingMetadata: true,
  });
  return {
    command: `docker exec -i ${shellQuote(target.containerName)} sh -c ${shellQuote(writeScript)}`,
    input,
  };
}

/** Write secret-bearing managed runtime config through SSH stdin, never command argv. */
export async function writeManagedElizaRuntimeConfig(
  ssh: DockerSSHClient,
  target: ManagedElizaRuntimeConfigTarget,
  allEnv: Record<string, string | undefined>,
): Promise<void> {
  const request = buildManagedElizaRuntimeConfigWriteRequest(target, allEnv);
  await ssh.execStdin(request.command, request.input, DOCKER_CMD_TIMEOUT_MS);
}

function stewardSshStdinFrameHeader(purpose: StewardSshStdinPurpose): string {
  return `${STEWARD_SSH_STDIN_FRAME_VERSION}:${purpose}`;
}

function encodeStewardSshStdinFrame(purpose: StewardSshStdinPurpose, payload: string): string {
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes === 0 || payloadBytes > MAX_STEWARD_SSH_STDIN_PAYLOAD_BYTES) {
    throw new Error("[docker-sandbox] Invalid Steward stdin payload size");
  }
  if (payload.includes("\0")) {
    throw new Error("[docker-sandbox] Invalid NUL byte in Steward stdin payload");
  }
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  return `${stewardSshStdinFrameHeader(purpose)}\n${encoded}\n${STEWARD_SSH_STDIN_FRAME_END}\n`;
}

/**
 * Build an operation-specific Python command which validates a bounded,
 * versioned stdin frame before parsing its JSON payload. Invalid input produces
 * only a fixed diagnostic and received bytes are never reflected to stderr.
 */
function buildStewardFramedPythonCommand(
  purpose: StewardSshStdinPurpose,
  operationBody: string,
): string {
  const maxFrameBytes = MAX_STEWARD_SSH_STDIN_BASE64_BYTES + 256;
  const parser = `import base64
import json
import sys

MAX_FRAME_BYTES = ${maxFrameBytes}
EXPECTED_HEADER = ${JSON.stringify(stewardSshStdinFrameHeader(purpose))}
EXPECTED_END = ${JSON.stringify(STEWARD_SSH_STDIN_FRAME_END)}


def invalid_stdin():
    print("[docker-sandbox] Invalid Steward stdin payload", file=sys.stderr)
    raise SystemExit(64)


raw_frame = sys.stdin.buffer.read(MAX_FRAME_BYTES + 1)
if not raw_frame or len(raw_frame) > MAX_FRAME_BYTES:
    invalid_stdin()

frame_parts = raw_frame.split(b"\\n")
if len(frame_parts) != 4 or frame_parts[3] != b"":
    invalid_stdin()
if frame_parts[0] != EXPECTED_HEADER.encode("ascii") or frame_parts[2] != EXPECTED_END.encode("ascii"):
    invalid_stdin()
if not frame_parts[1] or len(frame_parts[1]) > ${MAX_STEWARD_SSH_STDIN_BASE64_BYTES}:
    invalid_stdin()

try:
    raw_payload_bytes = base64.b64decode(frame_parts[1], validate=True)
    if base64.b64encode(raw_payload_bytes) != frame_parts[1]:
        invalid_stdin()
    if not raw_payload_bytes or len(raw_payload_bytes) > ${MAX_STEWARD_SSH_STDIN_PAYLOAD_BYTES}:
        invalid_stdin()
    payload = json.loads(
        raw_payload_bytes.decode("utf-8"),
        parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
    )
except Exception:
    invalid_stdin()

${operationBody}`;
  return `python3 -c ${shellQuote(parser)}`;
}

export function resolveDockerSandboxImage(
  dockerImage?: string,
  operatorOverride = DOCKER_IMAGE_OVERRIDE,
): string {
  return dockerImage || operatorOverride || "ghcr.io/elizaos/eliza:latest";
}

export function buildManagedElizaRuntimeConfig(
  allEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  const apiKey = allEnv.ELIZAOS_CLOUD_API_KEY || "";
  const agentId = allEnv.ELIZA_CLOUD_AGENT_ID || allEnv.WAIFU_ELIZA_CLOUD_AGENT_ID;
  const directEmbeddingProvider =
    allEnv.ELIZAOS_CLOUD_USE_EMBEDDINGS?.trim().toLowerCase() === "false" &&
    Boolean(allEnv.EMBEDDING_BASE_URL?.trim() || allEnv.EMBEDDING_API_KEY?.trim());

  return {
    logging: { level: "info" },
    deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
    ...(apiKey
      ? {
          linkedAccounts: {
            elizacloud: {
              status: "linked",
              source: "api-key",
            },
          },
        }
      : {}),
    serviceRouting: buildDefaultElizaCloudServiceRouting({
      // Canonical routing wins over process env during PID1 boot. Persist the
      // same direct embedding ownership selected by managed provisioning;
      // otherwise the default Eliza Cloud route below flips
      // ELIZAOS_CLOUD_USE_EMBEDDINGS back to true. Legacy agents without a
      // direct provider and explicit Cloud opt-ins keep cloud-proxy routing.
      base: directEmbeddingProvider
        ? { embeddings: { backend: "embeddings", transport: "direct" } }
        : undefined,
      includeInference: true,
      nanoModel: allEnv.ELIZAOS_CLOUD_NANO_MODEL,
      smallModel: allEnv.ELIZAOS_CLOUD_SMALL_MODEL,
      mediumModel: allEnv.ELIZAOS_CLOUD_MEDIUM_MODEL,
      largeModel: allEnv.ELIZAOS_CLOUD_LARGE_MODEL,
      megaModel: allEnv.ELIZAOS_CLOUD_MEGA_MODEL,
      responseHandlerModel: allEnv.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL,
      shouldRespondModel: allEnv.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL,
      actionPlannerModel: allEnv.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL,
      plannerModel: allEnv.ELIZAOS_CLOUD_PLANNER_MODEL,
      responseModel: allEnv.ELIZAOS_CLOUD_RESPONSE_MODEL,
      mediaDescriptionModel: allEnv.ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL,
    }),
    cloud: {
      enabled: Boolean(apiKey),
      apiKey,
      baseUrl: allEnv.ELIZAOS_CLOUD_BASE_URL || "",
      ...(agentId ? { agentId } : {}),
    },
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveElizaCloudPublicUrl(): string {
  const env = getCloudAwareEnv();
  const candidates = [
    env.ELIZA_CLOUD_PUBLIC_URL,
    env.PUBLIC_URL,
    env.NEXT_PUBLIC_API_URL,
    env.NEXT_PUBLIC_APP_URL,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    return trimTrailingSlash(candidate.trim());
  }
  return "https://api.eliza.app/api";
}

function resolveStewardRefreshUrl(): string {
  const env = getCloudAwareEnv();
  if (typeof env.STEWARD_REFRESH_URL === "string" && env.STEWARD_REFRESH_URL.trim()) {
    return env.STEWARD_REFRESH_URL.trim();
  }
  return `${resolveElizaCloudPublicUrl()}/v1/agent-tokens`;
}

function resolveStewardRefreshServiceToken(): string {
  const env = getCloudAwareEnv();
  for (const candidate of [env.ELIZA_CLOUD_SERVICE_TOKEN, env.AGENT_TOKEN_SERVICE_TOKEN]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/**
 * Strip secret-bearing fields from a persisted character before it is injected
 * into the container as ELIZA_AGENT_CHARACTER_JSON. The container receives the
 * actual connector tokens / API keys via dedicated env vars; embedding them in
 * the character JSON would expose them via /proc/<pid>/environ and crash
 * diagnostics for no benefit. Redacts:
 *   - top-level `secrets`
 *   - `settings.secrets`
 *   - per-connector `token` / `botToken` / `apiToken` under `connectors.*`
 * Persona + connector POLICY fields (dmPolicy, messagePrefix, enabled, etc.)
 * are preserved so the runtime still loads the right character + behaviour.
 */
function redactCharacterSecrets(character: Record<string, unknown>): Record<string, unknown> {
  // Deep clone so we never mutate the caller's DB-derived object.
  const clone = JSON.parse(JSON.stringify(character)) as Record<string, unknown>;
  delete clone.secrets;
  if (clone.settings && typeof clone.settings === "object") {
    delete (clone.settings as Record<string, unknown>).secrets;
  }
  const connectors = clone.connectors;
  if (connectors && typeof connectors === "object") {
    for (const value of Object.values(connectors as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const c = value as Record<string, unknown>;
        delete c.token;
        delete c.botToken;
        delete c.apiToken;
      }
    }
  }
  return clone;
}

/**
 * Resolve the AGENT_SERVER_SHARED_SECRET to inject into a provisioned
 * container so it can validate the X-Server-Token the cloud gateways attach to
 * forwarded platform messages. Precedence:
 *   1. An explicit per-deployment value in the sandbox's environment_vars.
 *   2. The daemon's own AGENT_SERVER_SHARED_SECRET (the same value the
 *      gateways read), so both ends share one secret with no extra config.
 * Returns an empty object when neither is set, leaving the container's
 * X-Server-Token path disabled (no regression).
 */
function resolveServerSharedSecretEnv(
  environmentVars: Record<string, string>,
): Record<string, string> {
  const explicit = environmentVars.AGENT_SERVER_SHARED_SECRET;
  if (typeof explicit === "string" && explicit.trim()) {
    return { AGENT_SERVER_SHARED_SECRET: explicit.trim() };
  }
  const env = getCloudAwareEnv();
  const daemonSecret = env.AGENT_SERVER_SHARED_SECRET;
  if (typeof daemonSecret === "string" && daemonSecret.trim()) {
    return { AGENT_SERVER_SHARED_SECRET: daemonSecret.trim() };
  }
  return {};
}

function resolveStewardElizaPluginPackage(): string {
  const env = getCloudAwareEnv();
  return typeof env.STEWARD_ELIZA_PLUGIN_PACKAGE === "string" &&
    env.STEWARD_ELIZA_PLUGIN_PACKAGE.trim()
    ? env.STEWARD_ELIZA_PLUGIN_PACKAGE.trim()
    : "@stwd/eliza-plugin";
}

function shouldInstallStewardPlugin(
  agentId: string,
  environmentVars: Record<string, string>,
): boolean {
  const env = getCloudAwareEnv();
  return (
    agentId.toLowerCase() === "sol" ||
    environmentVars.STEWARD_ENABLE_TRADE_PLUGIN === "true" ||
    env.STEWARD_ENABLE_TRADE_PLUGIN === "true"
  );
}

type HeadscaleRouteEnv = Partial<
  Record<
    | "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK"
    | "CONTAINERS_PUBLIC_BASE_DOMAIN"
    | "ELIZA_CLOUD_AGENT_BASE_DOMAIN"
    | "ENVIRONMENT"
    | "HEADSCALE_API_KEY"
    | "HEADSCALE_API_URL"
    | "HEADSCALE_PUBLIC_URL",
    string | undefined
  >
>;

function currentHeadscaleRouteEnv(): HeadscaleRouteEnv {
  const cloudEnv = getCloudAwareEnv();
  return {
    AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: cloudEnv.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK,
    CONTAINERS_PUBLIC_BASE_DOMAIN: cloudEnv.CONTAINERS_PUBLIC_BASE_DOMAIN,
    ELIZA_CLOUD_AGENT_BASE_DOMAIN: cloudEnv.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    ENVIRONMENT: cloudEnv.ENVIRONMENT,
    HEADSCALE_API_KEY: cloudEnv.HEADSCALE_API_KEY,
    HEADSCALE_API_URL: cloudEnv.HEADSCALE_API_URL,
    HEADSCALE_PUBLIC_URL: cloudEnv.HEADSCALE_PUBLIC_URL,
  };
}

function isBridgeHostFallbackEnabled(env: HeadscaleRouteEnv): boolean {
  return (
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "true" ||
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "1"
  );
}

function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isCloudDeploymentEnvironment(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "production" || normalized === "staging";
}

export function requiresHeadscaleRoute(
  env: HeadscaleRouteEnv = (() => {
    // Bind once: calling getCloudAwareEnv() per-key creates a fresh Proxy
    // per call. If the underlying CF bindings flip mid-evaluation, the reads
    // would not see a consistent snapshot. Pin one proxy and read every key.
    return currentHeadscaleRouteEnv();
  })(),
): boolean {
  if (isBridgeHostFallbackEnabled(env)) return false;
  return (
    hasConfiguredValue(env.HEADSCALE_API_KEY) ||
    hasConfiguredValue(env.HEADSCALE_API_URL) ||
    hasConfiguredValue(env.HEADSCALE_PUBLIC_URL) ||
    hasConfiguredValue(env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ||
    hasConfiguredValue(env.CONTAINERS_PUBLIC_BASE_DOMAIN) ||
    isCloudDeploymentEnvironment(env.ENVIRONMENT)
  );
}

/**
 * Whether the sandbox should actively enroll in the Headscale/tailnet VPN
 * (inject TS_AUTHKEY, add the tun device + NET_ADMIN cap, and wait for a
 * headscale_ip).
 *
 * Requires a configured `HEADSCALE_API_KEY` *and* that the operator has not
 * explicitly opted into legacy bridge-host routing. Gating on the fallback
 * flag here — not just in {@link requiresHeadscaleRoute} — keeps the escape
 * hatch internally consistent: without it, `AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK`
 * only relaxes the "must register a headscale_ip" guard while TS_AUTHKEY is
 * still injected, so the container entrypoint hard-`tailscale up`s and dies
 * under `set -e` when headscale is unreachable — the exact failure the flag is
 * meant to bypass on nodes that aren't on the mesh.
 */
export function headscaleVpnEnabled(env: HeadscaleRouteEnv): boolean {
  return hasConfiguredValue(env.HEADSCALE_API_KEY) && !isBridgeHostFallbackEnabled(env);
}

export function shouldCleanupHeadscaleVpn(
  env: HeadscaleRouteEnv,
  registeredNodeName: string | undefined,
): registeredNodeName is string {
  return headscaleVpnEnabled(env) && hasConfiguredValue(registeredNodeName);
}

function validateStewardRefreshServiceToken(serviceToken: string): void {
  const payloadBytes = Buffer.byteLength(serviceToken, "utf8");
  if (
    payloadBytes === 0 ||
    payloadBytes > MAX_STEWARD_REFRESH_SERVICE_TOKEN_BYTES ||
    /[\0\r\n]/.test(serviceToken)
  ) {
    throw new Error("[docker-sandbox] Invalid Steward refresh service token stdin payload");
  }
}

/** Build the credential-free in-container loop; exported for exact shell syntax proof. */
export function buildStewardRefreshLoopScript(agentId: string): string {
  return [
    "set -eu",
    `agent_id=${shellQuote(agentId)}`,
    `refresh_url=${shellQuote(resolveStewardRefreshUrl())}`,
    `jwt_file=${shellQuote(STEWARD_JWT_FILE)}`,
    `service_token_file=${shellQuote(STEWARD_REFRESH_SERVICE_TOKEN_FILE)}`,
    `auth_header_file=${shellQuote(STEWARD_REFRESH_AUTH_HEADER_FILE)}`,
    'cleanup_refresh_files() { rm -f "$service_token_file" "$auth_header_file"; }',
    "trap cleanup_refresh_files EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'service_token=$(cat "$service_token_file")',
    "umask 077",
    'printf "authorization: Bearer %s\\n" "$service_token" > "$auth_header_file"',
    'chmod 600 "$auth_header_file"',
    "unset service_token",
    'rm -f "$service_token_file"',
    "while true; do",
    '  response=$(curl -fsS -X POST "$refresh_url" -H "content-type: application/json" -H @"$auth_header_file" --data "{\\"agentId\\":\\"$agent_id\\",\\"ttl\\":900}" || true)',
    '  token=$(printf "%s" "$response" | sed -n "s/.*\\"token\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p")',
    '  if [ -n "$token" ]; then',
    "    umask 077",
    '    printf "%s" "$token" > "$jwt_file"',
    '    echo "[steward-jwt-refresh] refreshed token for $agent_id at $(date -Iseconds)"',
    "  else",
    '    echo "[steward-jwt-refresh] refresh failed for $agent_id at $(date -Iseconds)" >&2',
    "  fi",
    "  sleep 600",
    "done",
  ].join("\n");
}

function buildStewardRefreshRequest(
  containerName: string,
  agentId: string,
  serviceToken: string,
): StewardSshStdinRequest {
  validateStewardRefreshServiceToken(serviceToken);
  const tokenWriteScript = buildAtomicStdinFileWriteScript(
    "/tmp",
    STEWARD_REFRESH_SERVICE_TOKEN_FILE,
  );
  const cleanupScript = `rm -f ${shellQuote(STEWARD_REFRESH_SERVICE_TOKEN_FILE)} ${shellQuote(
    STEWARD_REFRESH_AUTH_HEADER_FILE,
  )}`;
  const refreshScript = buildStewardRefreshLoopScript(agentId);

  return {
    command: [
      "set -eu",
      `docker exec -i ${shellQuote(containerName)} sh -c ${shellQuote(tokenWriteScript)}`,
      `if ! docker exec -d ${shellQuote(containerName)} sh -lc ${shellQuote(
        refreshScript,
      )}; then docker exec ${shellQuote(containerName)} sh -c ${shellQuote(
        cleanupScript,
      )} >/dev/null 2>&1 || true; exit 1; fi`,
    ].join("; "),
    input: serviceToken,
  };
}

/** Start Steward refresh with its service token transported only through SSH stdin. */
export async function startStewardRefreshSidecar(
  ssh: DockerSSHClient,
  containerName: string,
  agentId: string,
  serviceToken: string,
): Promise<void> {
  const request = buildStewardRefreshRequest(containerName, agentId, serviceToken);
  await ssh.execStdin(request.command, request.input, DOCKER_CMD_TIMEOUT_MS);
}

function buildStewardPluginInstallCommand(containerName: string): string {
  const pluginPackage = resolveStewardElizaPluginPackage();
  const installScript = [
    "set -eu",
    `npm install --prefix /app --save ${shellQuote(pluginPackage)}`,
    `echo ${shellQuote(`[steward-plugin] installed ${pluginPackage}`)}`,
  ].join("; ");
  return `docker exec ${shellQuote(containerName)} sh -lc ${shellQuote(installScript)}`;
}

/**
 * When USE_STEWARD_PROXY=true, route LLM and EVM RPC calls through the
 * Steward proxy reachable from the container at host.docker.internal:8080
 * (the proxy listens on the docker host). Returns an empty object when
 * proxy mode is disabled so callers can spread it unconditionally.
 */
export function buildStewardProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.USE_STEWARD_PROXY !== "true") return {};
  const base = "http://host.docker.internal:8080";
  return {
    STEWARD_PROXY_URL: base,
    OPENAI_BASE_URL: `${base}/openai/v1`,
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    BSC_RPC_URL: "https://bsc-dataseed.binance.org",
    BASE_RPC_URL: "https://mainnet.base.org",
    ETHEREUM_RPC_URL: "https://eth.llamarpc.com",
  };
}

/** Health-check polling: interval between retries (ms). */
const HEALTH_CHECK_POLL_INTERVAL_MS = 3_000;

/**
 * Headscale can publish the peer before the local tailscaled status snapshot
 * exposes its assigned IPv4. Registration discovery already spent the bounded
 * server-side join budget; retain another two-minute local-netmap window
 * instead of turning this distinct transient into a permanent identity
 * mismatch.
 */
const HEADSCALE_DOCKER_BINDING_MAX_OBSERVATIONS = 130;
const HEADSCALE_DOCKER_BINDING_TIMEOUT_MS = 130_000;
const HEADSCALE_DOCKER_BINDING_POLL_INTERVAL_MS = 1_000;

/**
 * Health-check polling: total timeout (ms). A cold dedicated agent (first image
 * pull + agent boot + ~20 plugins loading) can take up to ~5 min before
 * `/api/health` answers over the tailnet; 180s lost that race and failed the
 * provision even though the agent came up. 6 min gives slow cold boots room.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 360_000;

/**
 * Budget for the node-side SSH fallback probe that runs after the tailnet
 * poll has already burned the full HEALTH_CHECK_TIMEOUT_MS. Short on purpose:
 * by then the container has had the whole tailnet window to boot, so docker
 * health has settled — the fallback only needs to survive a couple of SSH
 * round-trips, not a cold boot.
 */
const HEALTH_CHECK_SSH_FALLBACK_TIMEOUT_MS = 30_000;

/**
 * When the whole SSH-probe budget was spent WITHOUT ever reaching the container
 * (every attempt failed at the SSH transport layer — connect/exec/stream error
 * or timeout), the probe never reached a verdict. Rather than immediately
 * concluding "not ready" (a false negative that wedges a healthy container's
 * row), retry the probe over a short extra window with backoff — a flapping SSH
 * pool or a briefly-unreachable node usually clears in seconds. If it STILL
 * only sees transport failures after this, the outcome is reported as
 * `transport_unresolved` (retryable), not `not_ready` (terminal).
 */
const HEALTH_CHECK_TRANSPORT_RETRY_WINDOW_MS = 20_000;
const HEALTH_CHECK_TRANSPORT_RETRY_BASE_MS = 1_000;
const HEALTH_CHECK_TRANSPORT_RETRY_MAX_MS = 5_000;

/** SSH command timeout for docker pull (can be slow on first pull). */
export const PULL_TIMEOUT_MS = 300_000; // 5 min

/** SSH command timeout for docker run / stop / rm. */
const DOCKER_CMD_TIMEOUT_MS = 60_000;

/** Bound each inline probe so transport loss cannot replace the 180s VPN budget. */
const MESH_JOIN_PROBE_TIMEOUT_MS = 5_000;
/** One reconnect-backed observation after Headscale exhausts its full budget. */
const MESH_JOIN_FINAL_PROBE_TIMEOUT_MS = 20_000;

export type DockerMeshJoinProbeVerdict =
  | { readonly status: "pending" }
  | {
      readonly status: "terminal";
      readonly reason: "auth_required" | "container_exited";
      readonly containerState: string | null;
      readonly exitCode: number | null;
    };

export interface DockerMeshJoinObservation {
  readonly containerState: string | null;
  readonly exitCode: number | null;
  readonly socketPresent: boolean;
  readonly daemonPresent: boolean;
  readonly statusQuery: "success" | "error";
  readonly backendState: string | null;
  readonly machineAuthorized: boolean | null;
  readonly authUrlPresent: boolean;
  readonly ipPresent: boolean;
  readonly defaultRoutePresent: boolean;
  readonly tunPresent: boolean;
  readonly headscaleReachable: boolean;
  readonly controlKeyFetched: boolean;
  readonly loginStarted: boolean;
  readonly registerRequestSent: boolean;
  readonly controlTransportFailed: boolean;
  readonly tlsFailed: boolean;
  readonly dnsFailed: boolean;
  readonly authKeyRejected: boolean;
  readonly interactiveAuthRequired: boolean;
  readonly tailscaleUpFailed: boolean;
  readonly agentStarted: boolean;
}

const DOCKER_CONTAINER_STATES = new Set([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
]);
const TAILSCALE_BACKEND_STATES = new Set([
  "NeedsLogin",
  "NeedsMachineAuth",
  "NoState",
  "Running",
  "Starting",
  "Stopped",
]);
const MESH_PROBE_SECTION = "__eliza_mesh_probe_section__=";

function meshProbeSection(output: string, name: string, next: string): string {
  const startMarker = `${MESH_PROBE_SECTION}${name}`;
  const endMarker = `${MESH_PROBE_SECTION}${next}`;
  const start = output.indexOf(startMarker);
  if (start < 0) return "";
  const contentStart = start + startMarker.length;
  const end = output.indexOf(endMarker, contentStart);
  return output.slice(contentStart, end < 0 ? output.length : end).trim();
}

/** Converts raw exact-candidate output into closed, privacy-safe mesh facts. */
export function classifyDockerMeshJoinObservation(output: string): DockerMeshJoinObservation {
  const stateMatch = /^state=(\S+) exit=(-?\d+)$/m.exec(output);
  const rawContainerState = stateMatch?.[1] ?? null;
  const containerState =
    rawContainerState && DOCKER_CONTAINER_STATES.has(rawContainerState) ? rawContainerState : null;
  const exitCode = stateMatch ? Number.parseInt(stateMatch[2]!, 10) : null;
  const socket = meshProbeSection(output, "socket", "status");
  const statusOutput = meshProbeSection(output, "status", "ip");
  const ipOutput = meshProbeSection(output, "ip", "logs");
  const logs = meshProbeSection(output, "logs", "daemonlog");
  const daemonLog = meshProbeSection(output, "daemonlog", "network");
  const network = meshProbeSection(output, "network", "end");

  let statusQuery: "success" | "error" = "error";
  let backendState: string | null = null;
  let machineAuthorized: boolean | null = null;
  let authUrlPresent = false;
  try {
    const parsed = JSON.parse(statusOutput) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tailscale status is not an object");
    }
    const status = parsed as Record<string, unknown>;
    const self =
      status.Self && typeof status.Self === "object" && !Array.isArray(status.Self)
        ? (status.Self as Record<string, unknown>)
        : null;
    statusQuery = "success";
    backendState =
      typeof status.BackendState === "string" && TAILSCALE_BACKEND_STATES.has(status.BackendState)
        ? status.BackendState
        : null;
    machineAuthorized =
      typeof self?.MachineAuthorized === "boolean" ? self.MachineAuthorized : null;
    authUrlPresent = typeof status.AuthURL === "string" && status.AuthURL.trim().length > 0;
  } catch {
    // error-policy:J3 Raw CLI output becomes an explicit closed query failure.
  }

  return {
    containerState,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    socketPresent: /^socket=present$/m.test(socket),
    daemonPresent: /^daemon=present$/m.test(socket),
    statusQuery,
    backendState,
    machineAuthorized,
    authUrlPresent,
    ipPresent: ipOutput
      .split(/\r?\n/)
      .some((line) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(line.trim())),
    defaultRoutePresent: /^route=present$/m.test(network),
    tunPresent: /^tun=present$/m.test(network),
    headscaleReachable: /^control=reachable$/m.test(network),
    controlKeyFetched: /^control_key=true$/m.test(daemonLog),
    loginStarted: /^login_started=true$/m.test(daemonLog),
    registerRequestSent: /^register_request=true$/m.test(daemonLog),
    controlTransportFailed: /^control_transport_failed=true$/m.test(daemonLog),
    tlsFailed: /^tls_failed=true$/m.test(daemonLog),
    dnsFailed: /^dns_failed=true$/m.test(daemonLog),
    authKeyRejected:
      /(?:auth(?:entication)? key|authkey).*(?:invalid|expired|already used)|(?:invalid|expired|already used).*(?:auth(?:entication)? key|authkey)/i.test(
        logs,
      ),
    interactiveAuthRequired: /requires interactive authorization/i.test(logs),
    tailscaleUpFailed: /tailscale up failed|tailscale authentication failed/i.test(logs),
    agentStarted:
      /starting (?:eliza|agent)|server (?:started|listening)|agent runtime started/i.test(logs),
  };
}

/** Encodes only closed observation fields for durable job diagnosis. */
export function formatDockerMeshJoinObservation(observation: DockerMeshJoinObservation): string {
  const value = (input: string | number | boolean | null): string =>
    input === null ? "unknown" : String(input);
  return [
    `container=${value(observation.containerState)}`,
    `exit=${value(observation.exitCode)}`,
    `socket=${observation.socketPresent}`,
    `daemon=${observation.daemonPresent}`,
    `status=${observation.statusQuery}`,
    `backend=${value(observation.backendState)}`,
    `authorized=${value(observation.machineAuthorized)}`,
    `authurl=${observation.authUrlPresent}`,
    `ip=${observation.ipPresent}`,
    `route=${observation.defaultRoutePresent}`,
    `tun=${observation.tunPresent}`,
    `control=${observation.headscaleReachable}`,
    `control_key=${observation.controlKeyFetched}`,
    `login_started=${observation.loginStarted}`,
    `register_request=${observation.registerRequestSent}`,
    `control_transport_failed=${observation.controlTransportFailed}`,
    `tls_failed=${observation.tlsFailed}`,
    `dns_failed=${observation.dnsFailed}`,
    `authkey_rejected=${observation.authKeyRejected}`,
    `interactive=${observation.interactiveAuthRequired}`,
    `up_failed=${observation.tailscaleUpFailed}`,
    `agent_started=${observation.agentStarted}`,
  ].join(",");
}

const ENTRYPOINT_MESH_AUTH_TERMINAL_PREFIXES: readonly string[] = [
  "[docker-entrypoint] tailscale requires interactive authorization (authurl/needsmachineauth);",
  "[cloud-agent-entrypoint] tailscale requires interactive authorization (authurl/needsmachineauth);",
  "[docker-entrypoint] fatal: headscale auth key expired/rejected and no persisted identity could reconnect; node needs re-keying",
  "[cloud-agent-entrypoint] fatal: headscale auth key expired/rejected and no persisted identity could reconnect; node needs re-keying",
];

function hasEntrypointMeshAuthTerminalEvidence(output: string): boolean {
  return output
    .toLowerCase()
    .split(/\r?\n/)
    .some((line) =>
      ENTRYPOINT_MESH_AUTH_TERMINAL_PREFIXES.some((prefix) => line.startsWith(prefix)),
    );
}

/**
 * Classify the bounded, secret-free Docker evidence collected while Headscale
 * registration is pending. Early admission deliberately accepts only the
 * entrypoint-owned marker/prefix or exit 78 as auth evidence: once Tailscale is
 * running, ordinary app/plugin logs share `docker logs` and may contain broad
 * phrases such as "invalid key" that must not tear down a healthy candidate.
 */
export function classifyDockerMeshJoinProbe(output: string): DockerMeshJoinProbeVerdict {
  const stateMatch = /^state=(\S+) exit=(-?\d+)$/m.exec(output);
  const containerState = stateMatch?.[1] ?? null;
  const exitCode = stateMatch ? Number.parseInt(stateMatch[2]!, 10) : null;
  if (
    exitCode === TS_AUTHKEY_EXPIRED_EXIT_CODE ||
    /^authkey-marker=present$/m.test(output) ||
    hasEntrypointMeshAuthTerminalEvidence(output)
  ) {
    return { status: "terminal", reason: "auth_required", containerState, exitCode };
  }
  if (containerState === "exited" || containerState === "dead") {
    return { status: "terminal", reason: "container_exited", containerState, exitCode };
  }
  return { status: "pending" };
}

/**
 * Retains every precise mesh failure behind the required-ingress verdict. The
 * first cause is also the native `cause` so durable job diagnostics can walk
 * through AggregateError without exposing its unrestricted `errors` payload.
 */
export function requiredHeadscaleIngressFailure(
  message: string,
  causes: readonly unknown[],
): Error {
  if (causes.length === 0) return new Error(message);
  return new AggregateError([...causes], message, { cause: causes[0] });
}

export async function probeDockerMeshJoinTerminalFailure(
  ssh: Pick<DockerSSHClient, "exec">,
  containerId: string,
  observe?: (observation: DockerMeshJoinObservation) => void,
  observeUnavailable?: (kind: ReturnType<typeof classifyDockerSshProbeError>) => void,
  timeoutMs: number = MESH_JOIN_PROBE_TIMEOUT_MS,
): Promise<Error | null> {
  const networkProbeScript = [
    `awk 'NR > 1 && $2 == "00000000" { found=1 } END { print found ? "route=present" : "route=absent" }' /proc/net/route 2>/dev/null || echo route=absent`,
    "test -c /dev/net/tun && echo tun=present || echo tun=absent",
    'url="${HEADSCALE_URL:-${TS_CONTROL_URL:-}}"',
    'code="$(curl -ksS --connect-timeout 3 --max-time 5 -o /dev/null -w "%{http_code}" "${url%/}/health" 2>/dev/null || true)"',
    'case "$code" in [1-5][0-9][0-9]) echo control=reachable ;; *) echo control=unreachable ;; esac',
  ].join("; ");
  const daemonLogProbeScript = [
    "log=/tmp/tailscaled.log",
    'grep -Eiq "control server key from" "$log" 2>/dev/null && echo control_key=true || echo control_key=false',
    'grep -Eiq "doLogin|client[.]Login|StartLoginInteractive" "$log" 2>/dev/null && echo login_started=true || echo login_started=false',
    'grep -Eiq "RegisterReq:|register request" "$log" 2>/dev/null && echo register_request=true || echo register_request=false',
    'grep -Eiq "fetch control key.*(failed|error|timeout)|control.*(dial|connect).*(failed|error|timeout|refused)|no route to host|network is unreachable" "$log" 2>/dev/null && echo control_transport_failed=true || echo control_transport_failed=false',
    'grep -Eiq "tls handshake|x509:|certificate.*(invalid|expired|unknown)" "$log" 2>/dev/null && echo tls_failed=true || echo tls_failed=false',
    'grep -Eiq "no such host|server misbehaving|temporary failure in name resolution" "$log" 2>/dev/null && echo dns_failed=true || echo dns_failed=false',
  ].join("; ");
  let output: string;
  try {
    output = await ssh.exec(
      [
        `docker inspect --format 'state={{.State.Status}} exit={{.State.ExitCode}}' ${shellQuote(containerId)} 2>/dev/null`,
        `docker exec ${shellQuote(containerId)} sh -c 'test -f "\${TS_STATE_DIR:-/var/lib/tailscale}/${TS_AUTHKEY_EXPIRED_MARKER_BASENAME}" && echo authkey-marker=present || echo authkey-marker=absent' 2>/dev/null || echo authkey-marker=unknown`,
        `echo ${MESH_PROBE_SECTION}socket`,
        `docker exec ${shellQuote(containerId)} sh -c 'test -S /tmp/tailscaled.sock && echo socket=present || echo socket=absent; daemon=absent; for comm in /proc/[0-9]*/comm; do read -r name < "$comm" 2>/dev/null || true; if [ "$name" = tailscaled ]; then daemon=present; break; fi; done; echo daemon=$daemon' 2>/dev/null || true`,
        `echo ${MESH_PROBE_SECTION}status`,
        `docker exec ${shellQuote(containerId)} tailscale --socket=/tmp/tailscaled.sock status --json 2>/dev/null || true`,
        `echo ${MESH_PROBE_SECTION}ip`,
        `docker exec ${shellQuote(containerId)} tailscale --socket=/tmp/tailscaled.sock ip -4 2>/dev/null || true`,
        `echo ${MESH_PROBE_SECTION}logs`,
        `docker logs --tail 80 ${shellQuote(containerId)} 2>&1 || true`,
        `echo ${MESH_PROBE_SECTION}daemonlog`,
        `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(daemonLogProbeScript)} 2>/dev/null || true`,
        `echo ${MESH_PROBE_SECTION}network`,
        `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(networkProbeScript)} 2>/dev/null || true`,
        `echo ${MESH_PROBE_SECTION}end`,
      ].join("; "),
      timeoutMs,
    );
  } catch (error) {
    // error-policy:J1 This is an early transport observation, not the
    // authoritative registration verdict. Preserve the normal Headscale
    // budget unless Docker returned positive terminal evidence.
    const failureKind = classifyDockerSshProbeError(error);
    observeUnavailable?.(failureKind);
    logger.debug(
      "[docker-sandbox] Early mesh-join probe unavailable; registration remains pending",
      {
        containerId,
        failureKind,
      },
    );
    return null;
  }

  observe?.(classifyDockerMeshJoinObservation(output));
  const verdict = classifyDockerMeshJoinProbe(output);
  if (verdict.status === "pending") return null;
  return new ElizaError(
    `Docker candidate cannot complete required Headscale registration: ${verdict.reason}`,
    {
      code: "SANDBOX_MESH_JOIN_TERMINAL",
      context: {
        containerId,
        reason: verdict.reason,
        containerState: verdict.containerState,
        exitCode: verdict.exitCode,
      },
      severity: "ephemeral",
    },
  );
}

/**
 * Dedicated, tighter SSH timeout for the stop/rm calls on the delete path.
 * `docker stop` uses its own `-t 10` grace, so 25s caps the whole stop path
 * without ever truncating a legitimate graceful shutdown. Keeping this under
 * the 60s generic timeout is what stops one wedged delete from holding the
 * cycle (and the DB advisory lock) open across the full minute.
 */
const STOP_CMD_TIMEOUT_MS = 25_000;
const TEARDOWN_ABSENCE_PROBE_TIMEOUT_MS = 12_000;
const TEARDOWN_DOCKER_SELF_HEAL_STAGE_TIMEOUT_MS = 25_000;

/** Cap on best-effort Headscale VPN cleanup during sandbox teardown. */
const HEADSCALE_CLEANUP_TIMEOUT_MS = 15_000;

/** Autoscaled node readiness polling. */
const AUTOSCALED_NODE_READY_TIMEOUT_MS = 4 * 60 * 1000;
const AUTOSCALED_NODE_READY_POLL_MS = 10_000;

function getDockerHealthCmd(port: string, path = "/api/health"): string {
  if (!/^\d+$/.test(port)) {
    throw new Error(`[docker-sandbox] Invalid port "${port}": must be a numeric string.`);
  }
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(path)) {
    throw new Error(`[docker-sandbox] Invalid health check path "${path}".`);
  }
  // /api/health returns 200 or 401 (auth required) — both mean the server is up.
  // Use curl with -o /dev/null and check status code to accept either.
  return `sh -lc 'STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}${path}" 2>/dev/null); [ "$STATUS" = "200" ] || [ "$STATUS" = "401" ]'`;
}

export function resolveContainerPort(config: SandboxCreateConfig): string {
  const requested =
    typeof config.environmentVars.PORT === "string" && config.environmentVars.PORT.trim()
      ? config.environmentVars.PORT.trim()
      : typeof config.environmentVars.HTTP_PORT === "string" &&
          config.environmentVars.HTTP_PORT.trim()
        ? config.environmentVars.HTTP_PORT.trim()
        : typeof config.container?.port === "number"
          ? String(config.container.port)
          : DEFAULT_AGENT_PORT;
  if (!/^\d+$/.test(requested)) {
    throw new Error(`[docker-sandbox] Invalid container port "${requested}".`);
  }
  return requested;
}

/** Resolved sandbox self-registration backend (the provider-side mirror of the
 * sandbox-side `buildSandboxRegistryFromEnv`). */
export interface SandboxRegistryResolution {
  /** Registry URL the sandbox should register into (empty = none). */
  url: string;
  /** Bearer token (REST endpoints only; redis:// URLs carry their own auth). */
  token: string;
  /** True when `url` is a `redis(s)://` TCP URL. */
  isTcp: boolean;
  /** Whether the sandbox can register: a URL plus either TCP or a token. */
  canSelfRegister: boolean;
  /** Non-null when `url` has an unexpected scheme (registration may fail). */
  schemeWarning: string | null;
}

/**
 * Resolve the sandbox registry backend from the provider environment. Pure
 * mirror of the inline logic the provisioner used to carry, exported so the
 * security-relevant self-registration decision (#8621 inbound routing) is
 * unit-testable and can't silently drift (#8756). Resolution order:
 *   1. `SANDBOX_REGISTRY_REDIS_URL` (+ optional `_TOKEN`) — explicit override.
 *   2. `KV_REST_API_URL` + `KV_REST_API_TOKEN` — legacy Upstash REST.
 */
export function resolveSandboxRegistryEnv(
  env: NodeJS.ProcessEnv = process.env,
): SandboxRegistryResolution {
  const explicitRegistryUrl = env.SANDBOX_REGISTRY_REDIS_URL?.trim() ?? "";
  const explicitRegistryToken = env.SANDBOX_REGISTRY_REDIS_TOKEN?.trim() ?? "";
  const kvRestUrl = env.KV_REST_API_URL?.trim() ?? "";
  const kvRestToken = env.KV_REST_API_TOKEN?.trim() ?? "";
  const url = explicitRegistryUrl || kvRestUrl;
  const token = explicitRegistryUrl ? explicitRegistryToken : kvRestToken;
  const isTcp = /^rediss?:\/\//i.test(url);
  const canSelfRegister = url !== "" && (isTcp || token !== "");
  const schemeWarning =
    canSelfRegister && !isTcp && !/^https?:\/\//i.test(url)
      ? `Sandbox registry URL has an unexpected scheme (${url.split(":")[0]}:) — expected redis(s):// or http(s)://. Registration may fail`
      : null;
  return { url, token, isTcp, canSelfRegister, schemeWarning };
}

function extractStewardToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("[docker-sandbox] Steward token endpoint returned an empty response");
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Steward API may return { token: "..." } or { data: { token: "..." } }.
    // Keep one fallback for agentToken in case an older Steward build uses
    // that field name.
    const candidate =
      parsed.token ??
      parsed.agentToken ??
      (typeof parsed.data === "object" && parsed.data !== null
        ? (parsed.data as Record<string, unknown>).token
        : undefined);

    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  } catch {
    // Some Steward builds may return the token as plain text.
  }

  // Sanity check: reject responses that look like HTML error pages or are
  // unreasonably long (e.g. a full HTML document instead of a token).
  if (trimmed.length > 2048) {
    throw new Error(
      "[docker-sandbox] Steward token response exceeds 2048 chars — likely not a valid token",
    );
  }
  if (trimmed.includes("<") || trimmed.includes(">")) {
    throw new Error(
      "[docker-sandbox] Steward token response contains HTML markers — likely an error page",
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      "[docker-sandbox] Steward token response contains whitespace — likely not a valid token",
    );
  }

  logger.warn(
    "[docker-sandbox] Steward token response was plain text instead of JSON; accepting legacy fallback",
  );
  return trimmed;
}

function warnMissingStewardTenantApiKey(apiKey?: string) {
  if (apiKey || hasWarnedMissingStewardTenantApiKey) {
    return;
  }

  hasWarnedMissingStewardTenantApiKey = true;
  logger.warn(
    "[docker-sandbox] STEWARD_TENANT_API_KEY is not set; Steward registration will run without tenant API key auth",
  );
}

function resolveStewardRequestSigningSecret(apiKey?: string): string | undefined {
  const env = getCloudAwareEnv();
  const explicit = env.STEWARD_REQUEST_SIGNING_SECRET?.trim();
  if (explicit) {
    return explicit;
  }
  const fromList = env.STEWARD_REQUEST_SIGNING_SECRETS?.split(",")
    .map((secret) => secret.trim())
    .find((secret) => secret.length > 0);
  return fromList ?? apiKey?.trim() ?? undefined;
}

function resolveStewardPlatformKey(): string | undefined {
  const env = getCloudAwareEnv();
  const single = env.STEWARD_PLATFORM_KEY?.trim();
  if (single) return single;
  const fromList = env.STEWARD_PLATFORM_KEYS?.split(",")
    .map((k) => k.trim())
    .find((k) => k.length > 0);
  return fromList || undefined;
}

function buildPlatformAgentPath(tenantId: string, agentId?: string): string {
  const base = `/platform/tenants/${encodeURIComponent(tenantId)}/agents`;
  return agentId ? `${base}/${encodeURIComponent(agentId)}` : base;
}

// Best-effort DELETE against Steward's platform agent endpoint for
// deletion paths (failed container create, missing Headscale registration).
// Uses the platform-key path so the daemon authenticates as a platform
// operator instead of impersonating a tenant owner session — Steward's
// `/agents/:id` (tenant-scoped) route requires `session-jwt + tenantRole
// owner|admin`, which a backend service cannot satisfy. The platform-key
// path `/platform/tenants/:id/agents/:id` is exactly what Steward exposes
// for this case (scope `platform:agent:delete`). Without signing the call
// 401s and the agent record stays around as a ghost, blocking retries.
export async function buildSignedDeleteAgentRequest(
  agentId: string,
  stewardTenant: StewardTenantCredentials,
): Promise<StewardSshStdinRequest> {
  const path = buildPlatformAgentPath(stewardTenant.tenantId, agentId);
  const platformKey = resolveStewardPlatformKey();
  const signingSecret = resolveStewardRequestSigningSecret(stewardTenant.apiKey);
  const headers: Record<string, string> = {
    "User-Agent": "eliza-cloud-provisioner/1.0",
    "X-Steward-Tenant": stewardTenant.tenantId,
    ...(platformKey ? { "X-Steward-Platform-Key": platformKey } : {}),
  };
  if (signingSecret !== undefined) {
    const signed = await buildStewardSignedHeaders({
      method: "DELETE",
      path,
      body: "",
      tenantId: stewardTenant.tenantId,
      ...(platformKey === undefined ? {} : { platformKey }),
      signingSecret,
    });
    Object.assign(headers, signed);
  }

  const operationBody = `import urllib.error
import urllib.request

EXPECTED_KEYS = {"baseUrl", "headers", "path"}
if type(payload) is not dict or set(payload) != EXPECTED_KEYS:
    invalid_stdin()
if any(type(payload[key]) is not str for key in ("baseUrl", "path")):
    invalid_stdin()
if type(payload["headers"]) is not dict or len(payload["headers"]) > 32:
    invalid_stdin()

base_url = payload["baseUrl"]
path = payload["path"]
if not base_url.startswith(("http://", "https://")) or any(char in base_url for char in "\\r\\n\\0"):
    invalid_stdin()
if not path.startswith("/") or any(char in path for char in "\\r\\n\\0"):
    invalid_stdin()

headers = {}
allowed_header_name = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
for name, value in payload["headers"].items():
    if type(name) is not str or type(value) is not str:
        invalid_stdin()
    if not name or any(char not in allowed_header_name for char in name):
        invalid_stdin()
    if len(value) > 8192 or any(char in value for char in "\\r\\n\\0"):
        invalid_stdin()
    headers[name] = value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, response_headers, new_url):
        return None


opener = urllib.request.build_opener(NoRedirect())
try:
    request = urllib.request.Request(f"{base_url}{path}", headers=headers, method="DELETE")
    with opener.open(request, timeout=15) as response:
        response.read(1)
except urllib.error.HTTPError as error:
    status = error.code
    error.close()
    print(f"[docker-sandbox] Steward agent delete failed with status {status}", file=sys.stderr)
    raise SystemExit(69)
except Exception:
    # The lifecycle callers retain best-effort cleanup semantics by catching
    # this fixed diagnostic; never reflect response bodies, headers, or input.
    print("[docker-sandbox] Steward agent delete request failed", file=sys.stderr)
    raise SystemExit(69)`;

  return {
    command: buildStewardFramedPythonCommand("steward-agent-delete", operationBody),
    input: encodeStewardSshStdinFrame(
      "steward-agent-delete",
      JSON.stringify({ baseUrl: resolveStewardHostUrl(), headers, path }),
    ),
  };
}

export async function deregisterAgentWithSteward(
  ssh: DockerSSHClient,
  agentId: string,
  stewardTenant: StewardTenantCredentials,
): Promise<void> {
  const request = await buildSignedDeleteAgentRequest(agentId, stewardTenant);
  await ssh.execStdin(request.command, request.input, DOCKER_CMD_TIMEOUT_MS);
}

async function buildStewardSignedHeaders(params: {
  method: string;
  path: string;
  body: string;
  tenantId: string;
  platformKey?: string;
  signingSecret: string;
}): Promise<Record<string, string>> {
  const headers = new Headers();
  headers.set("X-Steward-Tenant", params.tenantId);
  if (params.platformKey) {
    headers.set("X-Steward-Platform-Key", params.platformKey);
  }
  await signStewardMutatingRequest(
    params.signingSecret,
    params.method,
    params.path,
    headers,
    new TextEncoder().encode(params.body),
  );
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    // Strip tenant/platform-key — the caller adds them once to the framed
    // stdin header map. Avoid double-injection into the outbound request.
    if (name === "x-steward-tenant" || name === "x-steward-platform-key") {
      return;
    }
    out[name] = value;
  });
  return out;
}

export async function buildRegisterAgentWithStewardRequest(
  agentId: string,
  agentName: string,
  tenantId: string,
  apiKey?: string,
): Promise<StewardSshStdinRequest> {
  // The tenant-scoped POST /agents compatibility route requires a session-jwt with
  // owner|admin role (Steward `requireTenantAdminSession`), which a daemon
  // cannot satisfy. Switch to the platform-key path Steward exposes for
  // exactly this use-case: POST /platform/tenants/:id/agents (scope
  // `platform:agent:create`) and POST /platform/tenants/:id/agents/:id/token
  // (scope `platform:agent-token:create`). The tenant `apiKey` argument is
  // kept only for backwards-compat — we now authenticate via
  // STEWARD_PLATFORM_KEY.
  warnMissingStewardTenantApiKey(apiKey);
  const platformKey = resolveStewardPlatformKey();
  const agentBody = JSON.stringify({ id: agentId, name: agentName });
  // Steward caps agent-token expiry at 7d (validated in
  // packages/api/src/routes/platform.ts — "expiresIn must be a duration up
  // to 7d using s, m, h, or d"). The daemon refreshes agent JWTs via the
  // STEWARD_REFRESH_URL flow before they expire, so a 7d ceiling is fine.
  const tokenBody = JSON.stringify({ expiresIn: "7d" });
  const signingSecret = resolveStewardRequestSigningSecret(apiKey);
  const agentPath = buildPlatformAgentPath(tenantId);
  const tokenPath = `${buildPlatformAgentPath(tenantId, agentId)}/token`;
  const agentSignedHeaders =
    signingSecret === undefined
      ? {}
      : await buildStewardSignedHeaders({
          method: "POST",
          path: agentPath,
          body: agentBody,
          tenantId,
          ...(platformKey === undefined ? {} : { platformKey }),
          signingSecret,
        });
  const tokenSignedHeaders =
    signingSecret === undefined
      ? {}
      : await buildStewardSignedHeaders({
          method: "POST",
          path: tokenPath,
          body: tokenBody,
          tenantId,
          ...(platformKey === undefined ? {} : { platformKey }),
          signingSecret,
        });

  const commonHeaders = {
    "Content-Type": "application/json",
    "User-Agent": "eliza-cloud-provisioner/1.0",
    "X-Steward-Tenant": tenantId,
    ...(platformKey ? { "X-Steward-Platform-Key": platformKey } : {}),
  };
  const operationBody = `import urllib.error
import urllib.request

EXPECTED_KEYS = {
    "agentBody",
    "agentHeaders",
    "agentPath",
    "baseUrl",
    "tokenBody",
    "tokenHeaders",
    "tokenPath",
}
if type(payload) is not dict or set(payload) != EXPECTED_KEYS:
    invalid_stdin()
if any(
    type(payload[key]) is not str
    for key in ("agentBody", "agentPath", "baseUrl", "tokenBody", "tokenPath")
):
    invalid_stdin()
if any(type(payload[key]) is not dict for key in ("agentHeaders", "tokenHeaders")):
    invalid_stdin()

base_url = payload["baseUrl"]
agent_path = payload["agentPath"]
token_path = payload["tokenPath"]
if not base_url.startswith(("http://", "https://")) or any(char in base_url for char in "\\r\\n\\0"):
    invalid_stdin()
for path in (agent_path, token_path):
    if not path.startswith("/") or any(char in path for char in "\\r\\n\\0"):
        invalid_stdin()
for body_text in (payload["agentBody"], payload["tokenBody"]):
    try:
        body_value = json.loads(body_text)
    except (TypeError, ValueError):
        invalid_stdin()
    if type(body_value) is not dict:
        invalid_stdin()


def validated_headers(value):
    if len(value) > 32:
        invalid_stdin()
    result = {}
    allowed_header_name = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
    for name, header_value in value.items():
        if type(name) is not str or type(header_value) is not str:
            invalid_stdin()
        if not name or any(char not in allowed_header_name for char in name):
            invalid_stdin()
        if len(header_value) > 8192 or any(char in header_value for char in "\\r\\n\\0"):
            invalid_stdin()
        result[name] = header_value
    return result


agent_headers = validated_headers(payload["agentHeaders"])
token_headers = validated_headers(payload["tokenHeaders"])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, response_headers, new_url):
        return None


opener = urllib.request.build_opener(NoRedirect())


def post(path, body_text, headers, capture_body):
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=body_text.encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with opener.open(request, timeout=15) as response:
            response_body = response.read(65537) if capture_body else b""
            return response.status, response_body
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, b""
    except Exception:
        print("[docker-sandbox] Steward request failed", file=sys.stderr)
        raise SystemExit(69)


status, _body = post(agent_path, payload["agentBody"], agent_headers, False)
if status not in (200, 201, 202, 400, 409):
    raise SystemExit(f"Steward agent registration failed with status {status}")
# 400/409 = agent already exists, continue to token minting.

status, body = post(token_path, payload["tokenBody"], token_headers, True)
if status not in (200, 201):
    raise SystemExit(f"Steward token mint failed with status {status}")
if len(body) > 65536:
    raise SystemExit("Steward token response exceeded the bounded size")
try:
    print(body.decode("utf-8"))
except UnicodeDecodeError:
    raise SystemExit("Steward token response was not UTF-8")`;

  return {
    command: buildStewardFramedPythonCommand("steward-agent-register", operationBody),
    input: encodeStewardSshStdinFrame(
      "steward-agent-register",
      JSON.stringify({
        agentBody,
        agentHeaders: { ...commonHeaders, ...agentSignedHeaders },
        agentPath,
        baseUrl: resolveStewardHostUrl(),
        tokenBody,
        tokenHeaders: { ...commonHeaders, ...tokenSignedHeaders },
        tokenPath,
      }),
    ),
  };
}

export async function registerAgentWithSteward(
  ssh: DockerSSHClient,
  agentId: string,
  agentName: string,
  tenantId: string,
  apiKey?: string,
): Promise<string> {
  const request = await buildRegisterAgentWithStewardRequest(agentId, agentName, tenantId, apiKey);
  const rawToken = await ssh.execStdin(request.command, request.input, DOCKER_CMD_TIMEOUT_MS);
  return extractStewardToken(rawToken);
}

// ---------------------------------------------------------------------------
// DockerSandboxProvider
// ---------------------------------------------------------------------------

export class DockerSandboxProvider implements SandboxProvider {
  readonly computeFundingCapability = "host-lease-v1" as const;
  readonly replacementCreateSettlementCapability = "exact-success" as const;
  readonly exactRestoreCreateCapability = "stopped-quarantine-v1" as const;

  /**
   * In-memory container metadata cache.
   * On Workers/serverless this cache is per-request and starts empty — the DB
   * fallback in resolveContainer() handles rehydration. In long-lived processes
   * (Docker self-hosting) it persists across requests.
   */
  private containers = new Map<string, ContainerMeta>();
  private readonly replacementVpnSettleDelay: (milliseconds: number) => Promise<void>;
  private readonly headscaleDockerBindingDelay: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options?: {
    replacementVpnSettleDelay?: (milliseconds: number) => Promise<void>;
    headscaleDockerBindingDelay?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  }) {
    this.replacementVpnSettleDelay =
      options?.replacementVpnSettleDelay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.headscaleDockerBindingDelay =
      options?.headscaleDockerBindingDelay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options?.now ?? Date.now;
  }

  // ------------------------------------------------------------------
  // create
  // ------------------------------------------------------------------

  /**
   * Create a sandbox container with automatic retry on port-collision TOCTOU races.
   *
   * Wraps {@link _createOnce} in a retry loop (up to 3 attempts with jitter).
   * On each attempt, fresh ports are allocated. The single-attempt path proves
   * the failed candidate absent before a collision may retry; unresolved
   * cleanup carries its exact placement to the durable service fence.
   *
   * NOTE: The DB INSERT (in agent-sandbox.ts) happens *after* this method
   * returns. If that INSERT hits a UNIQUE constraint violation (PG 23505),
   * the caller should call `stop(sandboxId)` to remove the ghost container
   * and then retry the full flow.
   */
  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    assertContainerBackedExecutionTier(config.executionTier);
    if (config.exactRestore !== undefined) {
      return this.createExactRestore(config, freezeExactRestoreConfig(config.exactRestore));
    }
    const requestedReplacementAttemptId = config.replacementAttemptId;
    if (requestedReplacementAttemptId !== undefined) {
      assertSandboxReplacementAttemptId(requestedReplacementAttemptId);
    }
    const hasAttemptStartedCallback = Boolean(config.onReplacementCreateAttemptStarted);
    const hasSettlementCallback = Boolean(config.onReplacementCreateSettled);
    if (hasAttemptStartedCallback !== hasSettlementCallback) {
      throw new ElizaError(
        "Exact sandbox replacement start and settlement callbacks must be supplied together",
        {
          code: "SANDBOX_REPLACEMENT_CREATE_SETTLEMENT_PAIR_REQUIRED",
          context: { replacementAttemptId: requestedReplacementAttemptId ?? null },
          severity: "fatal",
        },
      );
    }
    const exactSuccessMode = hasAttemptStartedCallback && hasSettlementCallback;
    if (exactSuccessMode && requestedReplacementAttemptId === undefined) {
      throw new ElizaError(
        "Exact sandbox replacement settlement requires a caller-owned attempt ID",
        {
          code: "SANDBOX_REPLACEMENT_CALLER_ATTEMPT_ID_REQUIRED",
          severity: "fatal",
        },
      );
    }
    // Legacy callers retain the provider-generated default. Exact-success
    // callers are admitted above only with their already durable identity.
    const replacementAttemptId = requestedReplacementAttemptId ?? crypto.randomUUID();
    if (
      (config.onReplacementCreated ||
        config.onReplacementVpnRegistered ||
        config.onReplacementCreateSettled) &&
      !config.onReplacementCreateIntent
    ) {
      throw new ElizaError(
        "Sandbox replacement enrichment and settlement callbacks require a durable create intent callback",
        {
          code: "SANDBOX_REPLACEMENT_CREATE_INTENT_REQUIRED",
          context: { replacementAttemptId },
          severity: "fatal",
        },
      );
    }
    if (config.onReplacementCreateSettled && !config.onReplacementCreated) {
      throw new ElizaError(
        "Exact sandbox replacement settlement requires pre-start Docker create enrichment",
        {
          code: "SANDBOX_REPLACEMENT_CREATED_ENRICHMENT_REQUIRED",
          context: { replacementAttemptId },
          severity: "fatal",
        },
      );
    }

    // Customer runtime must enter through committed funding, including image
    // replacements. Reject before node selection, autoscale or SSH effects.
    // Exact restore returned above with a stopped, network-isolated candidate;
    // the explicit platform pool remains separately operator-controlled.
    if (
      config.organizationId !== WARM_POOL_ORG_ID &&
      typeof config.startFundedContainer !== "function"
    ) {
      throw new ElizaError("Dedicated container creation requires committed runtime funding", {
        code: "SANDBOX_COMPUTE_FUNDING_REQUIRED",
        context: { agentId: config.agentId, organizationId: config.organizationId },
      });
    }

    // Freeze one attempt identity at the public boundary. It is one-shot: an
    // exact cleanup tombstones this id remotely, so any later retry is a new
    // caller-owned invocation rather than a replay behind durable authority.
    const persistReplacementAttemptStarted = config.onReplacementCreateAttemptStarted;
    const persistReplacementIntent = config.onReplacementCreateIntent;
    const persistCreatedReplacement = config.onReplacementCreated;
    const persistRegisteredVpnReplacement = config.onReplacementVpnRegistered;
    const persistReplacementSettlement = config.onReplacementCreateSettled;
    let durableReplacementLocator: SandboxReplacementCleanupLocator | null = null;
    let completedIntentLocator: SandboxReplacementCleanupLocator | null = null;
    let completedCreatedLocator: SandboxReplacementCleanupLocator | null = null;
    let completedVpnLocator: SandboxReplacementCleanupLocator | null = null;
    let intentCompleted = false;
    let createdCompleted = false;
    let vpnCompleted = false;
    const exactStageInvoked = { intent: false, created: false, vpn: false };
    const exactReplacementLocator = (
      handle: SandboxHandle,
      stage: "intent" | "created" | "vpn" | "final",
    ): SandboxReplacementCleanupLocator => {
      const locator = replacementCleanupLocatorFromHandle(handle);
      const hasContainerId = Boolean(locator?.containerId?.trim());
      const hasCanonicalContainerId = isCanonicalDockerContainerId(locator?.containerId);
      const hasVpnNodeId = Boolean(locator?.vpnNodeId?.trim());
      const coreInvalid =
        !locator ||
        handle.sandboxId.trim().length === 0 ||
        !isCanonicalReplacementLocatorCore(locator, replacementAttemptId) ||
        (exactSuccessMode &&
          !isCanonicalExactReplacementLocator(locator, {
            containerName: getContainerName(config.agentId),
            replacementAttemptId,
          }));
      const stageInvalid =
        (stage === "intent" && (locator?.containerId !== null || locator?.vpnNodeId !== null)) ||
        ((stage === "created" || stage === "vpn" || stage === "final") &&
          !hasCanonicalContainerId) ||
        (stage === "created" && locator?.vpnNodeId !== null) ||
        (stage === "vpn" && !hasVpnNodeId);
      if (coreInvalid || stageInvalid) {
        throw new ElizaError(
          "Docker replacement callback metadata does not match its exact provider attempt",
          {
            code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
            context: {
              stage,
              replacementAttemptId,
              callbackReplacementAttemptId: locator?.replacementAttemptId ?? null,
              callbackSandboxId: handle.sandboxId || null,
              callbackNodeId: locator?.nodeId || null,
              callbackContainerName: locator?.containerName || null,
              callbackHasContainerId: hasContainerId,
              callbackHasVpnNodeId: hasVpnNodeId,
              callbackAllocationCounted: locator?.allocationCounted ?? null,
              callbackNodeRecordId: locator?.nodeRecordId ?? null,
              callbackNodeHostname: locator?.nodeHostname ?? null,
              callbackNodeSshPort: locator?.nodeSshPort ?? null,
              callbackHasPinnedHostKey: Boolean(locator?.nodeHostKeyFingerprint?.trim()),
              callbackSecretCleanupVersion: locator?.replacementSecretCleanupVersion ?? null,
            },
            severity: "fatal",
          },
        );
      }
      return locator;
    };
    const immutableReplacementKeys = [
      "sandboxId",
      "nodeId",
      "containerName",
      "replacementAttemptId",
      "allocationCounted",
      "nodeRecordId",
      "nodeHostname",
      "nodeSshPort",
      "nodeSshUser",
      "nodeHostKeyFingerprint",
      "replacementSecretCleanupVersion",
      "vpnNodeName",
      "vpnRegistrationStartedAt",
      "previousVpnNodeId",
    ] as const satisfies readonly (keyof SandboxReplacementCleanupLocator)[];
    const assertSameReplacementIdentity = (
      expected: SandboxReplacementCleanupLocator,
      actual: SandboxReplacementCleanupLocator,
      stage: "created" | "vpn" | "final",
    ): void => {
      const driftedKey = immutableReplacementKeys.find(
        (key) => (expected[key] ?? null) !== (actual[key] ?? null),
      );
      if (driftedKey) {
        throw new ElizaError("Docker replacement identity changed across durable stages", {
          code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_DRIFT",
          context: {
            stage,
            driftedKey,
            replacementAttemptId,
            expected: expected[driftedKey] ?? null,
            actual: actual[driftedKey] ?? null,
          },
          severity: "fatal",
        });
      }
    };
    const assertExactStageContinuity = (
      locator: SandboxReplacementCleanupLocator,
      stage: "created" | "vpn" | "final",
    ): void => {
      if (!exactSuccessMode) return;
      if (!intentCompleted || !completedIntentLocator) {
        throw new ElizaError("Exact replacement create intent did not complete", {
          code: "SANDBOX_REPLACEMENT_INTENT_NOT_COMPLETED",
          context: { stage, replacementAttemptId },
          severity: "fatal",
        });
      }
      assertSameReplacementIdentity(completedIntentLocator, locator, stage);
      if (stage === "created") return;
      if (!createdCompleted || !completedCreatedLocator) {
        throw new ElizaError("Exact replacement Docker create enrichment did not complete", {
          code: "SANDBOX_REPLACEMENT_CREATED_NOT_COMPLETED",
          context: { stage, replacementAttemptId },
          severity: "fatal",
        });
      }
      if (completedCreatedLocator.containerId !== locator.containerId) {
        throw new ElizaError("Docker replacement container ID changed after create enrichment", {
          code: "SANDBOX_REPLACEMENT_CONTAINER_ID_DRIFT",
          context: { stage, replacementAttemptId },
          severity: "fatal",
        });
      }
      if (stage === "vpn") return;
      const finalVpnNodeId = locator.vpnNodeId ?? null;
      if (vpnCompleted && completedVpnLocator) {
        if (completedVpnLocator.vpnNodeId !== locator.vpnNodeId) {
          throw new ElizaError("Docker replacement VPN node ID changed after enrichment", {
            code: "SANDBOX_REPLACEMENT_VPN_NODE_ID_DRIFT",
            context: { stage, replacementAttemptId },
            severity: "fatal",
          });
        }
      } else if (finalVpnNodeId !== null) {
        throw new ElizaError("Exact replacement VPN identity was not durably enriched", {
          code: "SANDBOX_REPLACEMENT_VPN_NOT_COMPLETED",
          context: { stage, replacementAttemptId },
          severity: "fatal",
        });
      }
    };
    const claimExactStageInvocation = (stage: "intent" | "created" | "vpn"): void => {
      if (!exactSuccessMode) return;
      if (exactStageInvoked[stage]) {
        throw new ElizaError("Exact replacement callback stage was invoked more than once", {
          code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
          context: { stage, replacementAttemptId },
          severity: "fatal",
        });
      }
      // Claim synchronously before the callback's first await. Completion is a
      // separate state: two concurrent invocations must not both observe false.
      exactStageInvoked[stage] = true;
    };
    const attemptStarted = Object.freeze({ replacementAttemptId });
    // This is the durable pre-effect fence for exact-success. A thrown or lost
    // callback response cannot permit placement or remote provider work, and
    // deliberately receives no success callback.
    if (persistReplacementAttemptStarted) {
      await persistReplacementAttemptStarted(attemptStarted);
    }
    const createConfig: SandboxCreateConfig = {
      ...config,
      replacementAttemptId,
      environmentVars: applyRemoteDockerRuntimeMode(config.environmentVars),
      ...(persistReplacementIntent
        ? {
            onReplacementCreateIntent: async (handle: SandboxHandle) => {
              const locator = exactReplacementLocator(handle, "intent");
              claimExactStageInvocation("intent");
              durableReplacementLocator = locator;
              await persistReplacementIntent(handle);
              completedIntentLocator = locator;
              intentCompleted = true;
            },
          }
        : {}),
      ...(persistCreatedReplacement
        ? {
            onReplacementCreated: async (handle: SandboxHandle) => {
              const locator = exactReplacementLocator(handle, "created");
              claimExactStageInvocation("created");
              assertExactStageContinuity(locator, "created");
              durableReplacementLocator = locator;
              try {
                await persistCreatedReplacement(handle);
              } catch (cause) {
                // error-policy:J2 never trust a callback-supplied typed error's
                // locator: rewrap it with the provider-validated candidate.
                throw new SandboxReplacementCleanupUnresolvedError(locator, cause);
              }
              completedCreatedLocator = locator;
              createdCompleted = true;
            },
          }
        : {}),
      ...(persistRegisteredVpnReplacement
        ? {
            onReplacementVpnRegistered: async (handle: SandboxHandle) => {
              const locator = exactReplacementLocator(handle, "vpn");
              claimExactStageInvocation("vpn");
              assertExactStageContinuity(locator, "vpn");
              durableReplacementLocator = locator;
              await persistRegisteredVpnReplacement(handle);
              completedVpnLocator = locator;
              vpnCompleted = true;
            },
          }
        : {}),
    };
    // Every durable replacement intent needs the precise provider-side cause,
    // even when its consumer defers primary cutover until a later health check
    // and therefore has no create-settlement callback. Without this tracker,
    // required Headscale failure collapsed to the generic missing-IP verdict.
    const remoteCompletionTracker = persistReplacementIntent
      ? ({ causes: [] } satisfies RemoteCompletionTracker)
      : undefined;
    let handle: SandboxHandle;
    try {
      handle = await this.createWithRetries(createConfig, remoteCompletionTracker);
    } catch (error) {
      // error-policy:J2 translate any post-intent provider failure into the
      // durable exact-locator fence, while preserving the pre-create CAS abort.
      if (
        durableReplacementLocator &&
        !(error instanceof ReplacementPlacementPersistenceError) &&
        !(error instanceof SandboxReplacementCleanupUnresolvedError)
      ) {
        throw new SandboxReplacementCleanupUnresolvedError(durableReplacementLocator, error);
      }
      throw error;
    }
    if (!persistReplacementSettlement) {
      return handle;
    }

    let locator: SandboxReplacementCleanupLocator;
    try {
      locator = exactReplacementLocator(handle, "final");
      assertExactStageContinuity(locator, "final");
      durableReplacementLocator = locator;
    } catch (error) {
      // error-policy:J2 a malformed success cannot discard an already durable
      // cleanup locator; without one, preserve the typed validation failure.
      if (durableReplacementLocator) {
        throw new SandboxReplacementCleanupUnresolvedError(durableReplacementLocator, error);
      }
      throw error;
    }
    if (remoteCompletionTracker && remoteCompletionTracker.causes.length > 0) {
      throw new SandboxReplacementCleanupUnresolvedError(
        locator,
        new AggregateError(
          [...remoteCompletionTracker.causes],
          "Remote replacement completion remained unresolved on an otherwise successful create",
        ),
      );
    }

    try {
      // Re-read the immutable placement record on primary immediately before
      // reporting provider success. The consumer's settlement transaction is
      // still the final CAS authority, but the provider must not knowingly
      // settle after a delete/reinsert or SSH-route mutation observed here.
      await this.resolveReplacementCleanupNode(locator);
    } catch (authorityError) {
      // error-policy:J2 retain the exact successful handle behind its locator.
      throw new SandboxReplacementCleanupUnresolvedError(locator, authorityError);
    }

    if (persistReplacementSettlement) {
      const settlement = Object.freeze({
        replacementAttemptId,
        outcome: "succeeded" as const,
      });
      try {
        // Only a proven success reaches this callback. Rejections and ambiguous
        // remote completion intentionally leave durable authority in flight.
        await persistReplacementSettlement(settlement);
      } catch (persistenceError) {
        // error-policy:J2 preserve the successful handle, exact locator, and
        // failed success-persistence write without retrying remote creation.
        throw new SandboxReplacementCreateSettlementCleanupUnresolvedError({
          settlement,
          locator,
          providerHandle: handle,
          persistenceError,
        });
      }
    }

    return handle;
  }

  private async resolveExactRestoreTarget(target: SandboxExactRestoreTarget): Promise<DockerNode> {
    const node = await dockerNodesRepository.findByIdOnPrimary(target.nodeRecordId);
    if (!node) {
      throw new ElizaError("Exact restore target record is no longer registered", {
        code: "SANDBOX_EXACT_RESTORE_TARGET_MISSING",
        context: { nodeRecordId: target.nodeRecordId, nodeId: target.nodeId },
        severity: "fatal",
      });
    }

    const drifted = [
      ["nodeRecordId", node.id, target.nodeRecordId],
      ["nodeId", node.node_id, target.nodeId],
      ["nodeIncarnation", node.node_incarnation, target.nodeIncarnation],
      ["nodeHistoryId", node.current_node_history_id, target.nodeHistoryId],
    ].find(([, actual, expected]) => actual !== expected);
    if (drifted) {
      throw new ElizaError("Exact restore target occurrence changed", {
        code: "SANDBOX_EXACT_RESTORE_TARGET_DRIFT",
        context: {
          nodeRecordId: target.nodeRecordId,
          nodeId: target.nodeId,
          driftedKey: drifted[0],
        },
        severity: "fatal",
      });
    }

    const configuredEnvironment = containersEnv.environment();
    const targetEnvironment =
      typeof node.metadata.environment === "string" ? node.metadata.environment : null;
    if (targetEnvironment !== configuredEnvironment) {
      throw new ElizaError("Exact restore target belongs to a different environment", {
        code: "SANDBOX_EXACT_RESTORE_TARGET_ENVIRONMENT_MISMATCH",
        context: {
          nodeRecordId: target.nodeRecordId,
          nodeId: target.nodeId,
          configuredEnvironment,
          targetEnvironment,
        },
        severity: "fatal",
      });
    }

    const targetArchitecture = inferNodeArchitectureFromMetadata(node.metadata);
    const expectedArchitecture =
      target.platform === "linux/amd64"
        ? "amd64"
        : target.platform === "linux/arm64"
          ? "arm64"
          : null;
    if (targetArchitecture === null || targetArchitecture !== expectedArchitecture) {
      throw new ElizaError(
        "Exact restore target architecture does not match its platform authority",
        {
          code: "SANDBOX_EXACT_RESTORE_TARGET_PLATFORM_MISMATCH",
          context: {
            nodeRecordId: target.nodeRecordId,
            nodeId: target.nodeId,
            platform: target.platform,
            targetArchitecture,
          },
          severity: "fatal",
        },
      );
    }

    const capacityProvisional =
      node.metadata.capacityProvisional === true || node.metadata.capacityProvisional === "true";
    if (
      !node.enabled ||
      node.status !== "healthy" ||
      node.placement_state !== "open" ||
      capacityProvisional
    ) {
      throw new ElizaError("Exact restore target is no longer eligible for materialization", {
        code: "SANDBOX_EXACT_RESTORE_TARGET_INELIGIBLE",
        context: {
          nodeRecordId: target.nodeRecordId,
          nodeId: target.nodeId,
          enabled: node.enabled,
          status: node.status,
          placementState: node.placement_state,
          capacityProvisional,
        },
        severity: "fatal",
      });
    }

    if (
      !node.hostname.trim() ||
      !Number.isSafeInteger(node.ssh_port) ||
      node.ssh_port < 1 ||
      node.ssh_port > 65_535 ||
      !node.ssh_user.trim() ||
      !node.host_key_fingerprint?.trim()
    ) {
      throw new ElizaError("Exact restore target lacks pinned SSH authority", {
        code: "SANDBOX_EXACT_RESTORE_TARGET_SSH_AUTHORITY_INVALID",
        context: { nodeRecordId: target.nodeRecordId, nodeId: target.nodeId },
        severity: "fatal",
      });
    }

    return node;
  }

  private assertExactRestoreHostAuthorityStable(
    expected: DockerNode,
    actual: DockerNode,
    target: SandboxExactRestoreTarget,
  ): void {
    const drifted = [
      ["hostname", expected.hostname, actual.hostname],
      ["sshPort", expected.ssh_port, actual.ssh_port],
      ["sshUser", expected.ssh_user, actual.ssh_user],
      ["hostKeyFingerprint", expected.host_key_fingerprint, actual.host_key_fingerprint],
    ].find(([, before, after]) => before !== after);
    if (drifted) {
      throw new ElizaError("Exact restore target host authority changed", {
        code: "SANDBOX_EXACT_RESTORE_TARGET_HOST_AUTHORITY_DRIFT",
        context: {
          nodeRecordId: target.nodeRecordId,
          nodeId: target.nodeId,
          driftedKey: drifted[0],
        },
        severity: "fatal",
      });
    }
  }

  private async createExactRestore(
    config: SandboxCreateConfig,
    exactRestore: SandboxExactRestoreCreateConfig,
  ): Promise<SandboxHandle> {
    const replacementAttemptId = config.replacementAttemptId;
    assertSandboxReplacementAttemptId(replacementAttemptId);
    validateAgentId(config.agentId);
    validateAgentName(config.agentName);
    for (const [key, value] of Object.entries(config.environmentVars)) {
      validateEnvKey(key);
      validateEnvValue(key, value);
    }
    if (
      !config.onReplacementCreateAttemptStarted ||
      !config.onReplacementCreateIntent ||
      !config.onReplacementCreated ||
      !config.onReplacementCreateSettled
    ) {
      throw new ElizaError(
        "Exact restore creation requires the complete exact-success callback set",
        {
          code: "SANDBOX_EXACT_RESTORE_CALLBACKS_REQUIRED",
          context: { replacementAttemptId },
          severity: "fatal",
        },
      );
    }
    if (config.onReplacementVpnRegistered) {
      throw new ElizaError("Exact restore quarantine cannot register a VPN identity", {
        code: "SANDBOX_EXACT_RESTORE_VPN_CALLBACK_FORBIDDEN",
        context: { replacementAttemptId },
        severity: "fatal",
      });
    }
    if (config.excludeNodeId !== undefined) {
      throw new ElizaError("Exact restore target cannot be combined with node exclusion", {
        code: "SANDBOX_EXACT_RESTORE_NODE_RESELECTION_FORBIDDEN",
        context: { nodeId: exactRestore.target.nodeId, excludedNodeId: config.excludeNodeId },
        severity: "fatal",
      });
    }
    if (config.dockerImage !== undefined && config.dockerImage !== exactRestore.imageReference) {
      throw new ElizaError("Exact restore image conflicts with the generic Docker image", {
        code: "SANDBOX_EXACT_RESTORE_IMAGE_CONFLICT",
        severity: "fatal",
      });
    }

    const containerName = exactRestoreContainerName(config.agentId, exactRestore.restoreAttemptId);
    const volumePath = exactRestoreVolumePath(config.agentId, exactRestore.restoreAttemptId);
    const containerPort = resolveContainerPort(config);
    const containerMemoryMb =
      config.container?.memoryMb ?? containersEnv.agentContainerMemoryLimitMb();
    const imageName = exactRestore.imageReference.slice(
      0,
      exactRestore.imageReference.indexOf("@"),
    );
    const platformImageReference = `${imageName}@${exactRestore.imagePlatformDigest}`;
    const platformFlags = dockerPlatformFlag(exactRestore.target.platform);
    const initialNode = await this.resolveExactRestoreTarget(exactRestore.target);
    const initialHostKeyFingerprint = initialNode.host_key_fingerprint!;
    // The generic handle shape still carries route fields, but quarantine has
    // no published host ports or reachable health surface by construction.
    const bridgePort = 0;
    const webUiPort = 0;
    const baseMetadata = {
      provider: "docker" as const,
      nodeId: exactRestore.target.nodeId,
      hostname: initialNode.hostname,
      nodeRecordId: exactRestore.target.nodeRecordId,
      nodeIncarnation: exactRestore.target.nodeIncarnation,
      nodeHistoryId: exactRestore.target.nodeHistoryId,
      nodeSshPort: initialNode.ssh_port,
      nodeSshUser: initialNode.ssh_user,
      nodeHostKeyFingerprint: initialHostKeyFingerprint,
      containerName,
      bridgePort,
      webUiPort,
      agentId: config.agentId,
      volumePath,
      dockerImage: platformImageReference,
      imageDigest: exactRestore.imageDigest,
      imageIndexReference: exactRestore.imageReference,
      imagePlatformDigest: exactRestore.imagePlatformDigest,
      imagePlatform: exactRestore.target.platform,
      replacementAttemptId,
      restoreAttemptId: exactRestore.restoreAttemptId,
      quarantine: true as const,
      allocationCounted: true,
      replacementSecretCleanupVersion: 1 as const,
    } satisfies DockerSandboxMetadata;
    const handleFor = (containerId?: string): SandboxHandle => ({
      sandboxId: containerName,
      bridgeUrl: "",
      healthUrl: "",
      metadata: containerId ? { ...baseMetadata, containerId } : { ...baseMetadata },
    });
    let createdContainerId: string | undefined;
    const locatorFor = (
      containerId: string | undefined = createdContainerId,
    ): SandboxReplacementCleanupLocator => ({
      sandboxId: containerName,
      nodeId: exactRestore.target.nodeId,
      containerName,
      nodeRecordId: exactRestore.target.nodeRecordId,
      nodeIncarnation: exactRestore.target.nodeIncarnation,
      nodeHistoryId: exactRestore.target.nodeHistoryId,
      nodeHostname: initialNode.hostname,
      nodeSshPort: initialNode.ssh_port,
      nodeSshUser: initialNode.ssh_user,
      nodeHostKeyFingerprint: initialHostKeyFingerprint,
      replacementAttemptId,
      restoreAttemptId: exactRestore.restoreAttemptId,
      containerId,
      allocationCounted: true,
      replacementSecretCleanupVersion: 1,
    });

    if (containersEnv.registryToken() || containersEnv.registryTokenFile()) {
      throw new ElizaError(
        "Exact restore cannot use the legacy registry credential command transport",
        {
          code: "SANDBOX_EXACT_RESTORE_REGISTRY_CREDENTIAL_TRANSPORT_UNSUPPORTED",
          context: { nodeId: exactRestore.target.nodeId },
          severity: "fatal",
        },
      );
    }

    const started = Object.freeze({ replacementAttemptId });
    await config.onReplacementCreateAttemptStarted(started);

    let exactSsh: DockerSSHClient | null = null;
    try {
      try {
        await config.onReplacementCreateIntent(handleFor());
      } catch (cause) {
        // error-policy:J2 the verifier may have committed before its response
        // was lost, but no provider-side remote effect has started yet.
        throw new ReplacementPlacementPersistenceError(cause);
      }

      // Re-read primary authority after the awaited intent verifier and before
      // constructing an SSH client. Discovery, autoscale, and seed fallback are
      // deliberately absent from this exact branch.
      const node = await this.resolveExactRestoreTarget(exactRestore.target);
      this.assertExactRestoreHostAuthorityStable(initialNode, node, exactRestore.target);
      const ssh = (exactSsh = DockerSSHClient.createDedicated(
        node.hostname,
        node.ssh_port,
        node.host_key_fingerprint!,
        node.ssh_user,
      ));
      const exactRemoteCommand = (command: string): string =>
        buildExactRestoreBootFencedCommand(exactRestore.target.nodeIncarnation, command);
      const exactDockerRemoteCommand = (command: string): string =>
        buildExactRestoreDockerBootFencedCommand(exactRestore.target.nodeIncarnation, command);

      const manifestProofCapability = await ssh.exec(
        exactDockerRemoteCommand(
          [
            `docker version --format ${shellQuote("{{.Client.APIVersion}}|{{.Server.APIVersion}}")}`,
            `docker info --format ${shellQuote("{{json .DriverStatus}}")}`,
          ].join("; "),
        ),
        DOCKER_CMD_TIMEOUT_MS,
      );
      assertExactRestoreManifestProofCapability(
        manifestProofCapability,
        exactRestore.target.nodeId,
        replacementAttemptId,
      );

      await ssh.exec(
        exactRemoteCommand(buildExactRestorePreseedProofCommand(volumePath)),
        DOCKER_CMD_TIMEOUT_MS,
      );

      await ssh.exec(
        exactDockerRemoteCommand(
          buildExactRestoreAnonymousPullCommand(
            platformImageReference,
            exactRestore.target.platform,
          ),
        ),
        PULL_TIMEOUT_MS,
      );

      const allEnv = exactRestoreEnvironment(
        applyRemoteDockerRuntimeMode({
          ...config.environmentVars,
          ...(config.agentConfig && typeof config.agentConfig === "object"
            ? {
                ELIZA_AGENT_CHARACTER_JSON: JSON.stringify(
                  redactCharacterSecrets(config.agentConfig),
                ),
              }
            : {}),
          AGENT_NAME: config.agentName,
          ELIZA_CLOUD_PROVISIONED: "1",
          ELIZA_PORT: containerPort,
          PORT: containerPort,
          BRIDGE_PORT: DEFAULT_BRIDGE_PORT,
          AGENT_DISABLE_AUTO_API_TOKEN: "1",
          ELIZA_DISABLE_AUTO_API_TOKEN: "1",
          ELIZA_STATE_DIR:
            config.environmentVars.ELIZA_STATE_DIR?.trim() || CONTAINER_DURABLE_STATE_DIR,
        }),
      );
      delete allEnv.ELIZA_VAULT_PASSPHRASE;
      for (const [key, value] of Object.entries(allEnv)) {
        validateEnvKey(key);
        validateEnvValue(key, value);
      }
      const envTransport = buildDockerContainerEnvTransport(allEnv);
      const secretEnvPath = getReplacementControlSecretEnvPath(replacementAttemptId);
      const dockerCreateCommand = [
        "docker create",
        `--name ${shellQuote(containerName)}`,
        ...buildAgentContainerLabelFlags({
          agentId: config.agentId,
          organizationId: config.organizationId,
          containerClass: resolveAgentContainerClass(config.organizationId, {
            warmPoolOrgId: WARM_POOL_ORG_ID,
            testOrgIds: containersEnv.testOrgIds(),
          }),
        }),
        `--label ${shellQuote(`${REPLACEMENT_ATTEMPT_LABEL}=${replacementAttemptId}`)}`,
        `--label ${shellQuote(`${EXACT_RESTORE_ATTEMPT_LABEL}=${exactRestore.restoreAttemptId}`)}`,
        `--label ${shellQuote(`${EXACT_RESTORE_NODE_RECORD_LABEL}=${exactRestore.target.nodeRecordId}`)}`,
        `--label ${shellQuote(`${EXACT_RESTORE_NODE_INCARNATION_LABEL}=${exactRestore.target.nodeIncarnation}`)}`,
        `--label ${shellQuote(`${EXACT_RESTORE_NODE_HISTORY_LABEL}=${exactRestore.target.nodeHistoryId}`)}`,
        `--label ${shellQuote(`${EXACT_RESTORE_IMAGE_DIGEST_LABEL}=${exactRestore.imageDigest}`)}`,
        `--label ${shellQuote(`${EXACT_RESTORE_QUARANTINE_LABEL}=true`)}`,
        "--restart no",
        "--network none",
        "--no-healthcheck",
        ...buildAgentContainerMemoryFlags(containerMemoryMb),
        ...buildAgentContainerCpuFlags(
          config.container?.cpu !== undefined
            ? agentCpuUnitsToDockerCpus(config.container.cpu)
            : containersEnv.agentContainerCpuLimit(),
        ),
        ...buildAgentContainerSecurityFlags({ headscaleEnabled: false }),
        ...platformFlags,
        `-v ${shellQuote(volumePath)}:/app/data`,
        `-v ${shellQuote(`${volumePath}/eliza`)}:/root/.eliza`,
        ...envTransport.commandFlags,
        `--env-file ${shellQuote(secretEnvPath)}`,
        shellQuote(platformImageReference),
      ].join(" ");
      const createWithSecretEnvironment = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand,
        secretEnvPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(replacementAttemptId),
        exactReplacement: {
          containerName,
          replacementAttemptId,
          volumePath,
          recordContainerId: true,
        },
      });
      const secretInput = Buffer.from(envTransport.secretInput, "utf8");
      envTransport.secretInput = "";
      try {
        await ssh.execStdinAbortable(
          exactDockerRemoteCommand(createWithSecretEnvironment),
          secretInput,
          new AbortController().signal,
          DOCKER_CMD_TIMEOUT_MS,
        );
      } finally {
        secretInput.fill(0);
      }
      const containerId = extractExactRestoreDockerContainerId(
        await ssh.exec(
          exactRemoteCommand(buildReplacementCreatedContainerIdProofCommand(replacementAttemptId)),
          DOCKER_CMD_TIMEOUT_MS,
        ),
      );
      createdContainerId = containerId;
      const createdHandle = handleFor(containerId);
      try {
        await config.onReplacementCreated(createdHandle);
      } catch (cause) {
        // error-policy:J2 the exact stopped candidate remains fenced by its
        // durable locator when created-enrichment persistence is ambiguous.
        throw new SandboxReplacementCleanupUnresolvedError(locatorFor(containerId), cause);
      }

      const inspectFormat =
        "{{.Id}}|{{.Name}}|{{.State.Running}}|{{.State.Status}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.RestartPolicy.Name}}|{{json .HostConfig.PortBindings}}|{{.Config.Image}}|{{.Image}}|{{.Platform}}|{{.ImageManifestDescriptor.Digest}}|{{.ImageManifestDescriptor.Platform.OS}}/{{.ImageManifestDescriptor.Platform.Architecture}}";
      const proof = await ssh.exec(
        exactDockerRemoteCommand(
          `docker inspect --format ${shellQuote(inspectFormat)} ${shellQuote(containerId)}`,
        ),
        DOCKER_CMD_TIMEOUT_MS,
      );
      const proofLines = proof
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const proofFields = proofLines.length === 1 ? proofLines[0]!.split("|") : [];
      if (
        proofFields.length !== 12 ||
        proofFields[0] !== containerId ||
        proofFields[1] !== `/${containerName}` ||
        proofFields[2] !== "false" ||
        proofFields[3] !== "created" ||
        proofFields[4] !== "none" ||
        proofFields[5] !== "no" ||
        (proofFields[6] !== "{}" && proofFields[6] !== "null") ||
        proofFields[7] !== platformImageReference ||
        !/^sha256:[0-9a-f]{64}$/.test(proofFields[8] ?? "") ||
        proofFields[9] !== "linux"
      ) {
        throw new ElizaError("Exact restore candidate is not pristine and quarantined", {
          code: "SANDBOX_EXACT_RESTORE_QUARANTINE_PROOF_MISMATCH",
          context: {
            nodeId: exactRestore.target.nodeId,
            replacementAttemptId,
            containerId,
          },
          severity: "fatal",
        });
      }

      // `.Image` is only the config-image ID. Multiple manifests can share it,
      // and RepoDigests can consequently contain the expected child even when
      // a different manifest created the container. Docker's container-bound
      // descriptor is the authority for the child manifest actually selected.
      if (
        proofFields[10] !== exactRestore.imagePlatformDigest ||
        proofFields[11] !== exactRestore.target.platform
      ) {
        throw new ElizaError(
          "Exact restore container manifest descriptor does not match its authority",
          {
            code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_MISMATCH",
            context: {
              nodeId: exactRestore.target.nodeId,
              replacementAttemptId,
              containerId,
              platform: exactRestore.target.platform,
              imagePlatformDigest: exactRestore.imagePlatformDigest,
            },
            severity: "fatal",
          },
        );
      }

      const imageInspectFormat = "{{.Id}}|{{.Os}}/{{.Architecture}}|{{json .RepoDigests}}";
      const imageProof = await ssh.exec(
        exactDockerRemoteCommand(
          `docker image inspect --format ${shellQuote(imageInspectFormat)} ${shellQuote(proofFields[8]!)}`,
        ),
        DOCKER_CMD_TIMEOUT_MS,
      );
      const imageProofLines = imageProof
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const imageProofFields = imageProofLines.length === 1 ? imageProofLines[0]!.split("|") : [];
      let repoDigests: unknown = null;
      try {
        repoDigests = JSON.parse(imageProofFields[2] ?? "null");
      } catch {
        // error-policy:J3 an untrusted Docker inspect response must fail closed.
      }
      if (
        imageProofFields.length !== 3 ||
        imageProofFields[0] !== proofFields[8] ||
        imageProofFields[1] !== exactRestore.target.platform ||
        !Array.isArray(repoDigests) ||
        !repoDigests.includes(platformImageReference)
      ) {
        throw new ElizaError("Exact restore child image proof does not match its authority", {
          code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_MISMATCH",
          context: {
            nodeId: exactRestore.target.nodeId,
            replacementAttemptId,
            containerId,
            platform: exactRestore.target.platform,
            imagePlatformDigest: exactRestore.imagePlatformDigest,
          },
          severity: "fatal",
        });
      }

      const settlementNode = await this.resolveExactRestoreTarget(exactRestore.target);
      this.assertExactRestoreHostAuthorityStable(node, settlementNode, exactRestore.target);
      const settlement = Object.freeze({
        replacementAttemptId,
        outcome: "succeeded" as const,
      });
      try {
        await config.onReplacementCreateSettled(settlement);
      } catch (persistenceError) {
        // error-policy:J2 preserve the successful stopped handle and exact
        // locator without retrying Docker creation.
        throw new SandboxReplacementCreateSettlementCleanupUnresolvedError({
          settlement,
          locator: locatorFor(containerId),
          providerHandle: createdHandle,
          persistenceError,
        });
      }
      return createdHandle;
    } catch (error) {
      // error-policy:J2 every failure after the durable intent verifier keeps
      // the reserved occurrence fenced for exact reconciliation.
      if (
        error instanceof ReplacementPlacementPersistenceError ||
        error instanceof SandboxReplacementCleanupUnresolvedError
      ) {
        throw error;
      }
      throw new SandboxReplacementCleanupUnresolvedError(locatorFor(), error);
    } finally {
      await exactSsh?.disconnect();
    }
  }

  private async createWithRetries(
    config: SandboxCreateConfig,
    remoteCompletionTracker?: RemoteCompletionTracker,
  ): Promise<SandboxHandle> {
    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this._createOnce(config, remoteCompletionTracker);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (
          config.onReplacementCreateIntent ||
          lastError instanceof SandboxReplacementCleanupUnresolvedError
        ) {
          throw lastError;
        }
        const isPortCollision =
          lastError.message.includes("23505") ||
          lastError.message.includes("unique constraint") ||
          lastError.message.includes("already in use") ||
          lastError.message.includes("port is already allocated");

        if (!isPortCollision || attempt === MAX_ATTEMPTS) {
          throw lastError;
        }

        const containerName = getContainerName(config.agentId);
        logger.warn(
          `[docker-sandbox] Port collision on attempt ${attempt}/${MAX_ATTEMPTS} for ${containerName}; prior candidate absence is proven, retrying...`,
        );

        // Jitter: 200–800ms to desynchronise concurrent callers
        const jitterMs = 200 + Math.floor(Math.random() * 600);
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
      }
    }

    // Unreachable, but satisfies the compiler
    throw lastError ?? new Error("[docker-sandbox] create exhausted all retry attempts");
  }

  /**
   * Create a single sandbox container (no retry).
   *
   * TOCTOU note: Port allocation is racy under concurrent provisioning.
   * The DB has a partial UNIQUE index on (node_id, bridge_port) for active
   * sandboxes, so a duplicate will fail at INSERT time. The public `create()`
   * method wraps this in a retry loop to handle port collisions automatically.
   */
  private async _createOnce(
    config: SandboxCreateConfig,
    remoteCompletionTracker?: RemoteCompletionTracker,
  ): Promise<SandboxHandle> {
    const { agentId, agentName, environmentVars, organizationId, agentConfig, routeAgentId } =
      config;
    assertSandboxReplacementAttemptId(config.replacementAttemptId);
    const replacementAttemptId = config.replacementAttemptId;

    // Resolve Docker image: per-agent DB override > operator env override > hardcoded default.
    // Keep the fallback out of DOCKER_IMAGE_OVERRIDE so per-agent flavor/image
    // overrides are not accidentally shadowed by the generic Eliza default.
    const resolvedImage = resolveDockerSandboxImage(config.dockerImage);
    const imagePlatform = containersEnv.defaultAgentImagePlatform();
    const platformFlags = dockerPlatformFlag(imagePlatform);
    const containerPort = resolveContainerPort(config);
    const healthCheckPath = config.container?.healthCheckPath ?? "/api/health";

    // 1. Input validation
    validateAgentName(agentName);
    validateAgentId(agentId);
    // Reject env-file record splitting before node allocation, SSH, volume, or
    // vault setup can mutate remote state. Errors identify only the key.
    for (const [key, value] of Object.entries(environmentVars)) {
      validateEnvKey(key);
      validateEnvValue(key, value);
    }
    const providerManagesCapacity = !config.onReplacementCreateIntent;

    const env = currentHeadscaleRouteEnv();
    // Pass the same snapshot to requiresHeadscaleRoute so that both the
    // HEADSCALE_API_KEY presence check and the route-required decision read
    // from one consistent view of the environment.
    const headscaleRouteRequired = requiresHeadscaleRoute(env);
    const headscaleEnabled = headscaleVpnEnabled(env);
    if (headscaleRouteRequired && !headscaleEnabled) {
      const errorMessage =
        "Headscale routing is required for this cloud environment, but HEADSCALE_API_KEY is not configured. " +
        "Refusing to mark the agent running without a routable internal ingress; " +
        "set AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK=1 only for legacy public-host routing.";
      logger.error(`[docker-sandbox] ${errorMessage}`, {
        agentId,
      });
      throw new Error(errorMessage);
    }

    // 2. Select target node via DockerNodeManager (least-loaded, DB-backed).
    // getAvailableNode + incrementAllocated + getUsedDockerHostPorts are three sequential
    // DB round-trips without a transaction boundary; the UNIQUE port index and
    // retry logic provide safety against concurrent capacity changes.
    // The ceiling admitted here is the same value applied to `docker create`
    // below, so a node can never be accepted against one number and loaded with
    // another. Zero means the operator disabled ceilings entirely, which opts
    // this container out of memory admission rather than admitting it for free.
    const containerMemoryMb =
      config.container?.memoryMb ?? containersEnv.agentContainerMemoryLimitMb();
    let dbNode = await dockerNodeManager.getAvailableNode({
      requiredPlatform: imagePlatform,
      excludeNodeId: config.excludeNodeId,
      ...(containerMemoryMb > 0 ? { requiredMemoryMb: containerMemoryMb } : {}),
    });
    if (!dbNode) {
      dbNode = await this.provisionAutoscaledNodeForAgent(
        {
          image: resolvedImage,
          platform: imagePlatform,
          requiredMemoryMb: containerMemoryMb,
        },
        remoteCompletionTracker,
      );
    }

    if (remoteCompletionTracker) {
      const selectedNodeId = dbNode?.node_id ?? null;
      const selectedRecordId = dbNode?.id ?? null;
      // Selection may have read a replica snapshot before TOFU persisted its
      // pin, or the logical node id may have been deleted and reused. Resolve
      // the selected immutable record on primary before candidate effects and
      // never adopt a replacement row merely because node_id still matches.
      dbNode = selectedRecordId
        ? await dockerNodesRepository.findByIdOnPrimary(selectedRecordId)
        : null;
      if (
        dbNode?.id !== selectedRecordId ||
        dbNode?.node_id !== selectedNodeId ||
        !dbNode.host_key_fingerprint?.trim()
      ) {
        throw new ElizaError(
          "Exact-success Docker replacement requires a durably pinned database node",
          {
            code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
            context: { nodeId: selectedNodeId, nodeRecordId: selectedRecordId },
            severity: "fatal",
          },
        );
      }
    }

    let nodeId: string;
    let hostname: string;
    let sshPort = DEFAULT_SSH_PORT;
    let sshUser = DEFAULT_SSH_USERNAME;

    // host_key_fingerprint from DB node (null for env-var fallback, TOFU applies)
    let hostKeyFingerprint: string | undefined;

    if (dbNode) {
      nodeId = dbNode.node_id;
      hostname = dbNode.hostname;
      sshPort = dbNode.ssh_port ?? DEFAULT_SSH_PORT;
      sshUser = dbNode.ssh_user ?? DEFAULT_SSH_USERNAME;
      hostKeyFingerprint = dbNode.host_key_fingerprint ?? undefined;
      // Replacement intent persists the capacity reservation and placement in
      // one service transaction. Ordinary creates retain provider-owned
      // accounting because they have no durable replacement fence.
      if (providerManagesCapacity) {
        await dockerNodesRepository.incrementAllocated(nodeId);
      }
    } else {
      const registeredNodes = await dockerNodesRepository.findAll();
      if (registeredNodes.length > 0) {
        throw new ElizaError(
          "[docker-sandbox] Registered Docker nodes exist but none are available for placement; refusing CONTAINERS_DOCKER_NODES seed fallback",
          {
            code: "DOCKER_PLACEMENT_UNAVAILABLE",
            context: {
              registeredNodeCount: registeredNodes.length,
              excludedNodeId: config.excludeNodeId ?? null,
              requiredPlatform: imagePlatform ?? null,
            },
            severity: "ephemeral",
          },
        );
      }

      // Fallback: seed-only path for initial setup before nodes are registered via Admin API.
      // Uses random selection (no least-loaded placement or capacity checks).
      // Operators should register nodes via POST /admin/docker-nodes for production use.
      logger.warn(
        "[docker-sandbox] No nodes in DB, falling back to CONTAINERS_DOCKER_NODES env var (seed-only, no load balancing)",
      );
      const allEnvNodes = parseDockerNodes();
      const envNodes = config.excludeNodeId
        ? allEnvNodes.filter((n) => n.nodeId !== config.excludeNodeId)
        : allEnvNodes;
      if (envNodes.length === 0) {
        throw new Error(
          `[docker-sandbox] No nodes available (excludeNodeId=${config.excludeNodeId ?? "none"} filtered out all seed nodes)`,
        );
      }
      const envNode = envNodes[Math.floor(Math.random() * envNodes.length)]!;
      nodeId = envNode.nodeId;
      hostname = envNode.hostname;
      // Env-var nodes use defaults for SSH port/user — log a warning since
      // host key fingerprint is unavailable (TOFU applies)
      logger.warn(
        `[docker-sandbox] Env-var fallback node ${nodeId}: using SSH defaults (port ${sshPort}, user ${sshUser}, no fingerprint)`,
      );
    }

    // Freeze the database record and SSH authority used for this invocation.
    // Logical node_id is operator-facing and reusable; it is not sufficient to
    // recover a candidate after delete/recreate or host-tuple mutation.
    const nodePlacementMetadata = dbNode
      ? {
          nodeRecordId: dbNode.id,
          nodeSshPort: sshPort,
          nodeSshUser: sshUser,
          nodeHostKeyFingerprint: hostKeyFingerprint,
        }
      : {};
    const replacementPlacementMetadata = {
      ...nodePlacementMetadata,
      ...(remoteCompletionTracker ? { replacementSecretCleanupVersion: 1 as const } : {}),
    };

    logger.info(
      `[docker-sandbox] Creating container for agent ${agentId} on node ${nodeId} (${hostname})`,
    );

    // 3. Allocate ports (check DB for existing assignments to avoid collisions)
    const usedPorts = await getUsedDockerHostPorts(nodeId);
    const bridgePort = allocatePort(BRIDGE_PORT_MIN, BRIDGE_PORT_MAX, usedPorts);
    // No need to add bridgePort to exclusion set — web UI port range [20000,25000)
    // never overlaps bridge range [18790,19790)
    const webUiPort = allocatePort(WEBUI_PORT_MIN, WEBUI_PORT_MAX, usedPorts);
    const containerName = getContainerName(agentId);
    const volumePath = getVolumePath(agentId);
    let headscaleIp: string | null = null;
    let previousVpnNodeId: string | undefined;
    let vpnNodeId: string | undefined;
    let vpnRegistrationStartedAt: string | undefined;
    let replacementIntentPersisted = false;
    let createdContainerId: string | undefined;
    let vpnEnvVars: Record<string, string> = {};
    let lastMeshJoinObservation: DockerMeshJoinObservation | null = null;
    let lastMeshJoinProbeFailureKind: ReturnType<typeof classifyDockerSshProbeError> | null = null;
    const markRemoteCompletionUnresolved = (cause: unknown): void => {
      remoteCompletionTracker?.causes.push(cause);
    };

    const currentCleanupLocator = (): SandboxReplacementCleanupLocator => ({
      sandboxId: containerName,
      nodeId,
      containerName,
      ...replacementPlacementMetadata,
      replacementAttemptId,
      containerId: createdContainerId,
      vpnNodeId,
      vpnNodeName: vpnRegistrationStartedAt ? vpnEnvVars.TS_HOSTNAME : undefined,
      previousVpnNodeId,
      vpnRegistrationStartedAt,
      allocationCounted: Boolean(dbNode),
    });

    // Auto-provision the Steward tenant for this org if it doesn't have one
    // yet. Without this step, fresh organizations fall through to
    // `DEFAULT_STEWARD_TENANT_ID` ("elizacloud") — and if that default tenant
    // hasn't been pre-created on the Steward backend, `registerAgentWithSteward`
    // below fails with "Steward agent registration failed with status 404",
    // surfacing as "CLOUD CONNECTION NEEDS ATTENTION" in the desktop UI for
    // every newly-signed-in user. When `STEWARD_PLATFORM_KEYS` is not
    // configured (non-prod environments) this is a no-op that leaves the
    // compatibility fallback behavior intact.
    const stewardTenant: StewardTenantCredentials = organizationId
      ? await ensureStewardTenant(organizationId)
      : await resolveStewardTenantCredentials({ organizationId });

    // 4. Optionally prepare Headscale VPN
    // Collect VPN env vars separately to avoid mutating the caller's environmentVars.
    if (headscaleEnabled) {
      try {
        const vpnSetup = await headscaleIntegration.prepareContainerVPN({
          agentId,
          agentName,
          organizationId,
          // Blue/green passes false: the same-name node is LIVE and serving;
          // it is recorded here and deleted by id only after cutover (#16565).
          reclaimStaleNode: config.reclaimStaleVpnNode !== false,
          requireExactNodeRetirement: Boolean(remoteCompletionTracker),
        });
        vpnEnvVars = vpnSetup.envVars;
        previousVpnNodeId = vpnSetup.previousNodeId;
        logger.info(`[docker-sandbox] Headscale VPN enabled for ${agentId}`);
      } catch (err) {
        if (headscaleRouteRequired) {
          if (dbNode && providerManagesCapacity) {
            await dockerNodesRepository.decrementAllocated(nodeId).catch((rollbackErr) => {
              logger.warn(
                `[docker-sandbox] Failed to decrement allocated_count after Headscale preparation failure for node ${nodeId}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
              );
            });
          }
          throw err;
        }
        // error-policy:J4 optional local Headscale setup has an explicit
        // bridge-host degraded mode; required routing takes the branch above.
        markRemoteCompletionUnresolved(err);
        logger.warn(
          `[docker-sandbox] Headscale VPN preparation failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue without VPN — not a critical failure
      }
    }

    // 5. Build the base environment (spread to avoid mutating caller's environmentVars)
    const stewardContainerUrl = resolveStewardContainerEnvUrl();
    const proxyEnv = buildStewardProxyEnv();

    // Propagate the orchestrator's KMS configuration into the container so
    // field-level encryption (per-agent DB) uses the same backend + root
    // key on both ends. Without this the container's resolveKmsBackend() falls
    // through to the `steward` default and crashes at boot when no steward
    // config is present:
    //   "ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}"
    // which times out the sandbox health check and fails provisioning. The
    // daemon already requires a usable KMS, so inheriting its backend + root
    // key keeps the fleet consistent. Spread before `...environmentVars` so an
    // explicit per-agent override still wins. See elizaOS/eliza#8062.
    const kmsEnv: Record<string, string> = {};
    {
      const isKmsBackend = (v: string | undefined): v is string =>
        v === "memory" || v === "local" || v === "steward";
      const declared = environmentVars.ELIZA_KMS_BACKEND?.trim();
      const inherited = process.env.ELIZA_KMS_BACKEND?.trim();
      const backend = isKmsBackend(declared)
        ? declared
        : isKmsBackend(inherited)
          ? inherited
          : "local";
      kmsEnv.ELIZA_KMS_BACKEND = backend;
      if (backend === "local") {
        const rootKey =
          environmentVars.ELIZA_LOCAL_ROOT_KEY?.trim() || process.env.ELIZA_LOCAL_ROOT_KEY?.trim();
        if (rootKey) kmsEnv.ELIZA_LOCAL_ROOT_KEY = rootKey;
      }
    }

    const baseEnv: Record<string, string> = {
      ...kmsEnv,
      ...environmentVars,
      ...vpnEnvVars,
      ...proxyEnv,
      AGENT_NAME: agentName,
      ELIZA_CLOUD_PROVISIONED: "1",
      // Path A: inject the character so the container boots AS this agent
      // (e.g. "Nyx") instead of the bundled default "Eliza" preset. Consumed
      // by packages/agent/src/runtime/sandbox-character.ts. Secret-bearing
      // fields (connector tokens, secrets, settings.secrets) are redacted
      // first — the runtime receives connector tokens via dedicated env vars
      // (DISCORD_API_TOKEN, TELEGRAM_BOT_TOKEN) and never needs them embedded
      // in the character JSON, which would otherwise be visible via
      // /proc/<pid>/environ and crash diagnostics. Omitted when the caller has
      // no agent_config (the runtime keeps its default-character behaviour).
      ...(agentConfig && typeof agentConfig === "object"
        ? {
            ELIZA_AGENT_CHARACTER_JSON: JSON.stringify(redactCharacterSecrets(agentConfig)),
          }
        : {}),
      STEWARD_API_URL: stewardContainerUrl,
      STEWARD_AGENT_ID: agentId,
      // V2 image binds the eliza-api server to ELIZA_PORT, not PORT. Keep both
      // aligned to the requested app port so the daemon's HTTP probe (which hits
      // the host port mapped to container PORT) reaches the actual listener.
      ELIZA_PORT: containerPort,
      PORT: containerPort,
      BRIDGE_PORT: DEFAULT_BRIDGE_PORT,
      // Eliza server requires JWT_SECRET in production mode.
      // Generate a unique per-container secret if the caller didn't provide one.
      JWT_SECRET: environmentVars.JWT_SECRET || crypto.randomUUID(),
      // Allow the agent subdomain origin so the browser can call the API.
      ELIZA_ALLOWED_ORIGINS: `https://${agentId}.${getAgentBaseDomain()}`,
      // Shared service-to-service secret the cloud gateways attach as the
      // X-Server-Token header when they forward inbound platform messages to
      // this container's /agents/:id/message endpoint. The container's auth
      // path (packages/agent server-helpers-auth isAuthorized) accepts this
      // header when it matches, so a gateway can route a message without
      // knowing the per-agent inbound API token. Sourced from the daemon's own
      // AGENT_SERVER_SHARED_SECRET (the same value the gateways read); both
      // ends must share it. An explicit per-deployment value in
      // environmentVars wins. Omitted entirely when neither is set, which
      // simply leaves the X-Server-Token path disabled in the container.
      ...resolveServerSharedSecretEnv(environmentVars),
    };

    // 6. SSH to node, ensure volume dir, pull image, register in Steward,
    // then create/start the container. Pass hostKeyFingerprint so pooled
    // clients pin the key when available.
    const ssh = DockerSSHClient.getClient(hostname, sshPort, hostKeyFingerprint, sshUser);
    const cleanupNode: DockerNodeConnection = {
      node_id: nodeId,
      hostname,
      ssh_port: sshPort,
      ssh_user: sshUser,
      host_key_fingerprint: hostKeyFingerprint ?? null,
    };
    let stewardRegistrationCreated = false;

    try {
      // Ensure volume directory exists
      await ssh.exec(
        `mkdir -p ${shellQuote(volumePath)} ${shellQuote(`${volumePath}/eliza`)}`,
        DOCKER_CMD_TIMEOUT_MS,
      );

      // Pull image (may take a while on first run). Log in when registry
      // credentials are configured; otherwise rely on anonymous public pulls.
      logger.info(`[docker-sandbox] Pulling image ${resolvedImage} on ${nodeId}`);
      try {
        const registryAccess = await ensureRegistryAccess(ssh, resolvedImage);
        if (registryAccess.outcome === "unresolved") {
          markRemoteCompletionUnresolved(registryAccess.cause);
        }
        await ssh.exec(
          ["docker pull", ...platformFlags, shellQuote(resolvedImage)].join(" "),
          PULL_TIMEOUT_MS,
        );
        logger.info(`[docker-sandbox] Image pulled successfully on ${nodeId}`);
      } catch (pullErr) {
        markRemoteCompletionUnresolved(pullErr);
        logger.warn(
          `[docker-sandbox] Image pull failed on ${nodeId} (will use cached): ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`,
        );
      }

      // Steward's current control plane verifies Eliza-minted agent JWTs from
      // the public cloud JWKS. Its retired platform agent-registration/token
      // routes now return 404, so a configured signer is the canonical path
      // and must not be preceded by legacy remote registration.
      const stewardJwt = isAgentTokenSigningConfigured()
        ? (await mintAgentToken(agentId, 900)).token
        : "";
      let stewardAgentToken = "";
      if (stewardJwt) {
        logger.info(`[docker-sandbox] Using Eliza-minted Steward agent JWT for ${agentId}`);
      } else {
        logger.warn(
          "[docker-sandbox] AGENT_TOKEN_PRIVATE_KEY_PEM is not configured — falling back to legacy Steward agent registration",
        );
        logger.info(
          `[docker-sandbox] Registering ${agentId} with Steward tenant ${stewardTenant.tenantId} on ${nodeId}`,
        );
        stewardAgentToken = await registerAgentWithSteward(
          ssh,
          agentId,
          agentName,
          stewardTenant.tenantId,
          stewardTenant.apiKey,
        );
        stewardRegistrationCreated = true;
      }

      // Pass a registry backend through to the sandbox so it can self-register
      // `agent:<id>:server` + `server:<name>:url` keys that gateway-discord /
      // gateway-webhook resolve for inbound platform messages. The sandbox runs
      // on a Hetzner core node, so the URL must be reachable FROM THERE — a
      // public-proxy `redis://` URL (e.g. Railway) or an Upstash REST endpoint,
      // never a `*.railway.internal` host. Resolution order:
      //   1. SANDBOX_REGISTRY_REDIS_URL (+ optional _TOKEN): explicit operator
      //      override. A `redis://` / `rediss://` URL carries its own auth, so
      //      no token is needed; an `https://` Upstash URL needs the token.
      //   2. KV_REST_API_URL + KV_REST_API_TOKEN: Upstash REST compatibility.
      // Omit when neither is configured — the sandbox skips registration.
      const {
        url: registryRedisUrl,
        token: registryRedisToken,
        canSelfRegister,
        schemeWarning,
      } = resolveSandboxRegistryEnv(process.env);
      if (!canSelfRegister) {
        logger.warn(
          "[docker-sandbox] No sandbox registry backend configured — set SANDBOX_REGISTRY_REDIS_URL to a sandbox-reachable redis:// proxy, or KV_REST_API_URL/KV_REST_API_TOKEN to an Upstash REST endpoint. Sandbox will not register in Redis and gateways will not route inbound platform (Discord/Telegram) messages to it",
        );
      } else if (schemeWarning) {
        logger.warn(`[docker-sandbox] ${schemeWarning}`);
      }

      const stewardRefreshServiceToken = resolveStewardRefreshServiceToken();

      const keylessOpenAIEnv = buildKeylessOpenAIContainerEnv({
        stewardApiUrl: stewardContainerUrl,
        stewardAuthToken: stewardJwt || stewardAgentToken,
      });

      const allEnv: Record<string, string> = applyRemoteDockerRuntimeMode({
        ...baseEnv,
        ...(stewardAgentToken ? { STEWARD_AGENT_TOKEN: stewardAgentToken } : {}),
        ...(stewardJwt
          ? {
              STEWARD_JWT: stewardJwt,
              STEWARD_JWT_FILE,
              STEWARD_REFRESH_URL: resolveStewardRefreshUrl(),
              ...(stewardRefreshServiceToken
                ? { STEWARD_REFRESH_SERVICE_TOKEN: stewardRefreshServiceToken }
                : {}),
            }
          : {}),
        ...keylessOpenAIEnv,
        // Bind to 0.0.0.0 so Docker port mapping works (container otherwise
        // listens on 127.0.0.1 which is unreachable via -p host:container).
        // Set BOTH AGENT_API_BIND and ELIZA_API_BIND — the image default for
        // AGENT_API_BIND is 127.0.0.1 (loopback-only) which would make the
        // bridge port unreachable from outside the container.
        AGENT_API_BIND: "0.0.0.0",
        ELIZA_API_BIND: "0.0.0.0",
        // Prevent the server from auto-generating a RANDOM API token when bound
        // to 0.0.0.0.  The DB-provisioned ELIZA_API_TOKEN (set in baseEnv by
        // managed-agent-env.ts) is the canonical inbound auth token — the pair
        // flow hands it to the browser so the web UI can authenticate.  Clearing
        // it here caused isAuthorized() to reject every request on cloud-
        // provisioned containers (no token + cloud flag = 401).
        AGENT_DISABLE_AUTO_API_TOKEN: "1",
        ELIZA_DISABLE_AUTO_API_TOKEN: "1",
        // Durable state root on the `${volumePath}/eliza:/root/.eliza` mount.
        // Without it the runtime resolves state (including the vault) to
        // /root/.local/state/eliza in the container's writable layer, which
        // is lost on the normal container replacement/reschedule path.
        ELIZA_STATE_DIR: environmentVars.ELIZA_STATE_DIR?.trim() || CONTAINER_DURABLE_STATE_DIR,
        // Gateway service discovery — see SandboxRegistry in app-core.
        // SANDBOX_PUBLIC_URL targets the public Docker host (not the headscale
        // VPN IP set later at line ~653) because the gateways on Railway can't
        // route through Hetzner's private VPN.
        ...(canSelfRegister
          ? {
              SANDBOX_REGISTRY_REDIS_URL: registryRedisUrl,
              // Only the REST transport needs a token; a redis:// URL omits it.
              ...(registryRedisToken ? { SANDBOX_REGISTRY_REDIS_TOKEN: registryRedisToken } : {}),
              SANDBOX_AGENT_ID: agentId,
              // The gateways route by the platform character_id, so the
              // container must register under (and answer as) that id, not
              // the sandbox id. Injected only when the caller provides it.
              ...(routeAgentId?.trim() ? { SANDBOX_ROUTE_AGENT_ID: routeAgentId.trim() } : {}),
              SANDBOX_SERVER_NAME: `sandbox-${agentId}-${crypto.randomUUID()}`,
              SANDBOX_PUBLIC_URL: `http://${hostname}:${bridgePort}/api`,
            }
          : {}),
      });

      // The persisted vault value is appended to the stdin-backed env file on
      // the Docker host; never retain the caller's override in the generic env
      // map where it could accidentally return to command construction.
      delete allEnv.ELIZA_VAULT_PASSPHRASE;

      // Validate env keys/values before they are interpolated into remote shell commands.
      // Internal env vars must also remain UPPER_SNAKE_CASE so validation stays
      // consistent across caller-supplied and provider-generated values.
      for (const [key, value] of Object.entries(allEnv)) {
        validateEnvKey(key);
        validateEnvValue(key, value);
      }

      const envTransport = buildDockerContainerEnvTransport(allEnv);
      const secretEnvPath = remoteCompletionTracker
        ? getReplacementControlSecretEnvPath(replacementAttemptId)
        : getContainerSecretEnvPath(volumePath, replacementAttemptId);
      const vaultPassphrasePath = remoteCompletionTracker
        ? getReplacementControlVaultPassphrasePath(replacementAttemptId)
        : getVolumeVaultPassphrasePath(volumePath);

      const dockerCreateCmd = [
        "docker create",
        ...platformFlags,
        `--name ${shellQuote(containerName)}`,
        // Marking (user vs pool vs test) + managed-by, so fleet cleanup can
        // target debris without ever touching a real user's agent container.
        ...buildAgentContainerLabelFlags({
          agentId,
          organizationId,
          containerClass: resolveAgentContainerClass(organizationId, {
            warmPoolOrgId: WARM_POOL_ORG_ID,
            testOrgIds: containersEnv.testOrgIds(),
          }),
        }),
        `--label ${shellQuote(`${REPLACEMENT_ATTEMPT_LABEL}=${replacementAttemptId}`)}`,
        "--restart unless-stopped",
        `--network ${shellQuote(DOCKER_NETWORK)}`,
        ...(requiresDockerHostGateway(stewardContainerUrl) || Object.keys(proxyEnv).length > 0
          ? ["--add-host host.docker.internal:host-gateway"]
          : []),
        `--health-cmd ${shellQuote(getDockerHealthCmd(allEnv.PORT || containerPort, healthCheckPath))}`,
        "--health-interval 10s",
        "--health-timeout 5s",
        "--health-start-period 15s",
        "--health-retries 6",
        // Per-container memory ceiling (see buildAgentContainerMemoryFlags):
        // an explicit per-agent `container.memory` wins; otherwise the
        // env-tunable fleet default applies so a boot-looping agent can never
        // OOM-starve its co-tenants again (staging fleet incident 2026-08-05).
        ...buildAgentContainerMemoryFlags(containerMemoryMb),
        // Per-container CPU quota (see buildAgentContainerCpuFlags, #18485):
        // an explicit per-agent `container.cpu` wins; otherwise the
        // env-tunable fleet default applies so robot-density placement stays
        // safe — a busy-looping agent is throttled inside its own cgroup
        // instead of starving every co-tenant on a shared robot box.
        ...buildAgentContainerCpuFlags(
          config.container?.cpu !== undefined
            ? agentCpuUnitsToDockerCpus(config.container.cpu)
            : containersEnv.agentContainerCpuLimit(),
        ),
        // Escape-hardening (#12230/#12302): drop ALL kernel capabilities, forbid
        // privilege escalation, and bound the process count — then, under
        // headscale only, re-add exactly NET_ADMIN + /dev/net/tun for the VPN.
        // The builder guarantees --cap-drop=ALL precedes --cap-add=NET_ADMIN.
        ...buildAgentContainerSecurityFlags({ headscaleEnabled }),
        `-v ${shellQuote(volumePath)}:/app/data`,
        `-v ${shellQuote(`${volumePath}/eliza`)}:/root/.eliza`,
        // The cloud image serves both API and web UI from PORT (default 3000).
        // Publish both externally allocated host ports to that live listener so
        // nginx can reach /api/* via bridge_url and the UI via web_ui_port.
        `-p ${bridgePort}:${allEnv.PORT || DEFAULT_AGENT_PORT}`,
        `-p ${webUiPort}:${allEnv.PORT || DEFAULT_AGENT_PORT}`,
        ...envTransport.commandFlags,
        `--env-file ${shellQuote(secretEnvPath)}`,
        shellQuote(resolvedImage),
      ].join(" ");
      const dockerCreateWithSecretEnvCmd = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: dockerCreateCmd,
        secretEnvPath,
        vaultPassphrasePath,
        ...(remoteCompletionTracker
          ? { exactReplacement: { containerName, replacementAttemptId } }
          : {}),
      });

      // Self-heal nodes missing the shared bridge network (Robot cores never
      // run the cloud-init bootstrap; the network can also be pruned away).
      // Without this, `docker create --network` below fails with an opaque
      // "network not found" and the provision retries forever.
      await ssh.exec(buildEnsureNetworkCmd(DOCKER_NETWORK), DOCKER_CMD_TIMEOUT_MS);

      // A VPN candidate cannot register before Docker starts this container.
      // Arm the correlation window beside create, after successful Headscale
      // preparation has identified any preserved node.
      vpnRegistrationStartedAt = headscaleEnabled ? new Date(this.now()).toISOString() : undefined;
      const persistReplacementIntent = config.onReplacementCreateIntent;
      const containerId = extractDockerCreateContainerId(
        await createDockerContainerAfterReplacementIntent({
          persistIntent: persistReplacementIntent
            ? async () => {
                try {
                  await persistReplacementIntent({
                    sandboxId: containerName,
                    bridgeUrl: `http://${hostname}:${bridgePort}`,
                    healthUrl: `http://${hostname}:${webUiPort}/api`,
                    metadata: {
                      provider: "docker",
                      nodeId,
                      hostname,
                      ...replacementPlacementMetadata,
                      containerName,
                      bridgePort,
                      webUiPort,
                      agentId,
                      volumePath,
                      dockerImage: resolvedImage,
                      imageDigest: null,
                      replacementAttemptId,
                      allocationCounted: Boolean(dbNode),
                      vpnNodeName: vpnEnvVars.TS_HOSTNAME,
                      vpnRegistrationStartedAt,
                      previousVpnNodeId,
                    } satisfies DockerSandboxMetadata,
                  });
                  replacementIntentPersisted = true;
                } catch (cause) {
                  // error-policy:J2 the cleanup-intent transaction may have
                  // committed, but Docker create is still strictly downstream
                  // and is never invoked after this callback rejects.
                  throw new ReplacementPlacementPersistenceError(cause);
                }
              }
            : undefined,
          createContainer: async () => {
            // No plaintext temporary file is written until the durable intent
            // callback above has committed. Exact mode coordinates both vault
            // and Docker env producers with the remote attempt tombstone.
            await ensureVolumeVaultPassphrase(
              (cmd, input, timeoutMs) => ssh.execStdin(cmd, input, timeoutMs),
              volumePath,
              DOCKER_CMD_TIMEOUT_MS,
              environmentVars.ELIZA_VAULT_PASSPHRASE,
              remoteCompletionTracker ? replacementAttemptId : undefined,
            );
            return ssh.execStdin(
              dockerCreateWithSecretEnvCmd,
              envTransport.secretInput,
              DOCKER_CMD_TIMEOUT_MS,
            );
          },
        }),
        { requireFullId: Boolean(config.startFundedContainer) },
      );
      createdContainerId = containerId;
      const createdHandle: SandboxHandle = {
        sandboxId: containerName,
        bridgeUrl: `http://${hostname}:${bridgePort}`,
        healthUrl: `http://${hostname}:${webUiPort}/api`,
        metadata: {
          provider: "docker",
          nodeId,
          hostname,
          ...replacementPlacementMetadata,
          containerName,
          bridgePort,
          webUiPort,
          agentId,
          volumePath,
          dockerImage: resolvedImage,
          imageDigest: null,
          replacementAttemptId,
          containerId,
          allocationCounted: Boolean(dbNode),
          vpnNodeName: vpnEnvVars.TS_HOSTNAME,
          vpnRegistrationStartedAt,
          previousVpnNodeId,
        } satisfies DockerSandboxMetadata,
      };
      await config.onReplacementCreated?.(createdHandle);

      // Pre-seed the cloud runtime config on the HOST side of the
      // `${volumePath}/eliza:/root/.eliza` mount BEFORE starting the container,
      // so the agent's loadElizaConfig() at early boot already sees
      // deploymentTarget/serviceRouting. The post-start `docker exec` write
      // below otherwise races the agent's config read (~0.6s post-start vs the
      // ~0.2s boot-time read), leaving cloud agents stuck on runtime=local →
      // local_inference (#8434/#9887). Best-effort; the post-start write below
      // stays as a fallback (and overwrites with identical content).
      try {
        if (allEnv.ELIZAOS_CLOUD_BASE_URL) {
          await writeManagedElizaRuntimeConfig(ssh, { kind: "host-volume", volumePath }, allEnv);
          logger.info(`[docker-sandbox] Pre-seeded eliza.json on host volume for ${containerName}`);
        }
      } catch (preSeedErr) {
        markRemoteCompletionUnresolved(preSeedErr);
        logger.warn(
          `[docker-sandbox] Failed to pre-seed eliza.json (post-start write will retry): ${
            preSeedErr instanceof Error ? preSeedErr.message : String(preSeedErr)
          }`,
        );
      }

      if (config.startFundedContainer) {
        await config.startFundedContainer(createdHandle);
      } else {
        await ssh.exec(`docker start ${shellQuote(containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      }
      logger.info(
        `[docker-sandbox] Container created on ${nodeId}: ${containerId} (${containerName})`,
      );

      if (shouldInstallStewardPlugin(agentId, environmentVars)) {
        try {
          await ssh.exec(buildStewardPluginInstallCommand(containerName), PULL_TIMEOUT_MS);
          logger.info(`[docker-sandbox] Steward Eliza plugin installed in ${containerName}`);
        } catch (pluginErr) {
          markRemoteCompletionUnresolved(pluginErr);
          logger.warn(
            `[docker-sandbox] Failed to install Steward Eliza plugin in ${containerName}: ${pluginErr instanceof Error ? pluginErr.message : String(pluginErr)}`,
          );
        }
      }

      if (stewardJwt && stewardRefreshServiceToken) {
        try {
          await startStewardRefreshSidecar(ssh, containerName, agentId, stewardRefreshServiceToken);
          logger.info(`[docker-sandbox] Steward JWT refresh sidecar started in ${containerName}`);
        } catch (refreshErr) {
          markRemoteCompletionUnresolved(refreshErr);
          logger.warn(
            `[docker-sandbox] Failed to start Steward JWT refresh sidecar in ${containerName}: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
          );
        }
      }

      // Write ~/.eliza/eliza.json so the runtime sees cloud config even if
      // it bypasses env vars. Best-effort: a failure here is logged but
      // does not abort provisioning — the env vars on the container still
      // carry the same values.
      try {
        if (!allEnv.ELIZAOS_CLOUD_BASE_URL) {
          throw new Error(
            "[docker-sandbox] ELIZAOS_CLOUD_BASE_URL is not set in container env. " +
              "Refusing to fall back to the hardcoded prod URL (https://api.eliza.app/api/v1) — " +
              "this caused staging containers to silently call prod. " +
              "Configure ELIZAOS_CLOUD_BASE_URL in the daemon/Worker env (e.g. " +
              "https://api-staging.eliza.app/api/v1 for staging, https://api.eliza.app/api/v1 for prod).",
          );
        }
        await writeManagedElizaRuntimeConfig(ssh, { kind: "container", containerName }, allEnv);
        logger.info(`[docker-sandbox] Cloud config written to eliza.json in ${containerName}`);
      } catch (configErr) {
        markRemoteCompletionUnresolved(configErr);
        logger.warn(
          `[docker-sandbox] Failed to write eliza.json: ${configErr instanceof Error ? configErr.message : String(configErr)}`,
        );
      }
    } catch (err) {
      // Recorded before any rethrow branching below so every failure shape on
      // this node feeds the placement breaker (only timeouts count inside).
      notePlacementCommandFailure(nodeId, err);
      // Best-effort Steward deregistration — the agent was registered but the
      // container failed to start, so the Steward record is deleted here.
      if (stewardRegistrationCreated) {
        try {
          await deregisterAgentWithSteward(ssh, agentId, stewardTenant);
          logger.info(
            `[docker-sandbox] Cleaned up Steward agent ${agentId} after container failure`,
          );
        } catch (cleanupErr) {
          logger.warn(
            `[docker-sandbox] Failed to cleanup Steward agent ${agentId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }

      if (err instanceof SandboxReplacementCleanupUnresolvedError) {
        throw err;
      }
      const cleanupLocator = currentCleanupLocator();
      if (err instanceof ReplacementPlacementPersistenceError) {
        throw err;
      }
      if (replacementIntentPersisted) {
        throw new SandboxReplacementCleanupUnresolvedError(cleanupLocator, err);
      }

      try {
        await this.retireReplacementCandidateOnNode(cleanupLocator, cleanupNode);
      } catch (cleanupError) {
        // error-policy:J2 context-adding rethrow — replacement identity is retained
        // so the durable reconciler can retry the exact unresolved cleanup.
        if (cleanupError instanceof SandboxReplacementCleanupUnresolvedError) {
          throw cleanupError;
        }
        throw new SandboxReplacementCleanupUnresolvedError(cleanupLocator, cleanupError);
      }

      // Releasing capacity is safe only after the exact candidate and its known
      // VPN identity are absent. An unresolved cleanup retains the allocation
      // and escapes above with a durable locator.
      if (dbNode && providerManagesCapacity) {
        await dockerNodesRepository.decrementAllocated(nodeId).catch((rollbackErr) => {
          logger.error(
            `[docker-sandbox] Failed to roll back allocation for node ${nodeId}; capacity slot leaked: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
        });
      }
      throw new Error(
        `[docker-sandbox] Failed to create container on ${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const meta: ContainerMeta = {
      nodeId,
      hostname,
      containerName,
      bridgePort,
      webUiPort,
      agentId,
      // Headscale node name (TS_HOSTNAME) the container registered under, so
      // deletion can find and remove the node by the same name it was created with.
      tsHostname: vpnEnvVars.TS_HOSTNAME,
      previousVpnNodeId,
      sshPort,
      sshUser,
      hostKeyFingerprint,
    };
    this.containers.set(containerName, meta);
    // The container exists on the node — clear its breaker history so a
    // recovered node is not one stale timeout away from re-quarantine.
    clearPlacementCommandFailures(nodeId);

    // 8. Wait for Headscale VPN registration if enabled
    if (headscaleEnabled) {
      try {
        // Poll by the node's TS_HOSTNAME (what the container registers under via
        // inferTailscaleHostname), NOT the bare agentId — Headscale only knows the
        // node by that hostname, so polling by agentId never matched and the node
        // "timed out" registering despite being online.
        const meshJoinCandidateId = createdContainerId;
        let registration = await headscaleIntegration.waitForVPNRegistration(
          vpnEnvVars.TS_HOSTNAME ?? agentId,
          // The shared observer budget covers the container entrypoint's join
          // deadline and validates any deployment override before provisioning.
          DEFAULT_REGISTRATION_TIMEOUT_MS,
          {
            // During a blue/green overlap the preserved live node shares this
            // hostname — matching it would route the new sandbox to the OLD
            // container, the race the reclaim-mode deletion used to guard (#16565).
            ...(previousVpnNodeId ? { excludeNodeId: previousVpnNodeId } : {}),
            // The container can complete a collision-suffixed Headscale join
            // between Docker start and this poll. Use the persisted attempt
            // boundary so that valid early registration is not filtered out
            // as an orphan from a previous provision.
            ...(vpnRegistrationStartedAt
              ? { registrationStartedAt: new Date(vpnRegistrationStartedAt) }
              : {}),
            // The entrypoint is mesh-first, so app readiness cannot make
            // progress after an interactive AuthURL or terminal container exit.
            // Await this probe inside the registration loop: exact-success
            // cleanup can then retire the failed candidate and mint a new key
            // without blindly burning the remaining 180s registration budget.
            ...(meshJoinCandidateId
              ? {
                  probeTerminalCandidateFailure: () =>
                    probeDockerMeshJoinTerminalFailure(
                      ssh,
                      meshJoinCandidateId,
                      (observation) => {
                        lastMeshJoinObservation = observation;
                        lastMeshJoinProbeFailureKind = null;
                      },
                      (failureKind) => {
                        lastMeshJoinProbeFailureKind = failureKind;
                      },
                    ),
                }
              : {}),
          },
        );
        // Registration discovery already binds a canonical Headscale node to
        // this attempt's hostname, exclusion fence, and creation window. Keep
        // that immutable ID in the cleanup locator before comparing the
        // container's self-reported address. If the final binding check fails,
        // dropping the observed ID strands an offline Headscale node after the
        // exact Docker candidate is retired and makes the next provision race
        // a stale identity under the same deterministic name.
        if (registration) {
          vpnNodeId = registration.nodeId;
        }
        if (registration && remoteCompletionTracker) {
          try {
            if (!createdContainerId) {
              throw new ElizaError("Docker container identity is missing for Headscale binding", {
                code: "SANDBOX_HEADSCALE_DOCKER_IDENTITY_MISSING",
                context: { containerName, replacementAttemptId },
                severity: "fatal",
              });
            }
            let containerTailnetLines: string[] = [];
            let lastTailnetQueryError: unknown;
            const bindingDeadline = this.now() + HEADSCALE_DOCKER_BINDING_TIMEOUT_MS;
            for (
              let observation = 0;
              observation < HEADSCALE_DOCKER_BINDING_MAX_OBSERVATIONS;
              observation += 1
            ) {
              const remaining = bindingDeadline - this.now();
              if (remaining <= 0) break;
              try {
                const containerTailnetOutput = await ssh.exec(
                  `docker exec ${shellQuote(createdContainerId)} tailscale --socket=/tmp/tailscaled.sock ip -4`,
                  Math.min(DOCKER_CMD_TIMEOUT_MS, remaining),
                );
                containerTailnetLines = containerTailnetOutput
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean);
                lastTailnetQueryError = undefined;
              } catch (error: unknown) {
                // error-policy:J4 a pending local netmap remains unavailable
                // until the bounded observer proves the exact address binding.
                // A joining tailscaled can reject `ip -4` before its local
                // netmap catches up with the already-observed control-plane
                // registration. Preserve the final cause, but let the bounded
                // observer distinguish that transient from a terminal mismatch.
                lastTailnetQueryError = error;
                containerTailnetLines = [];
              }
              if (containerTailnetLines.length > 0) break;
              if (observation < HEADSCALE_DOCKER_BINDING_MAX_OBSERVATIONS - 1) {
                const delay = Math.min(
                  HEADSCALE_DOCKER_BINDING_POLL_INTERVAL_MS,
                  bindingDeadline - this.now(),
                );
                if (delay <= 0) break;
                await this.headscaleDockerBindingDelay(delay);
              }
            }
            const containerTailnetIp = containerTailnetLines[0];
            if (
              containerTailnetLines.length !== 1 ||
              !isCanonicalHeadscaleTailnetIpv4(containerTailnetIp) ||
              !isCanonicalHeadscaleTailnetIpv4(registration.ip) ||
              containerTailnetIp !== registration.ip ||
              !isCanonicalHeadscaleNodeId(registration.nodeId)
            ) {
              throw new ElizaError(
                "Headscale registration does not match the exact Docker candidate",
                {
                  code: "SANDBOX_HEADSCALE_DOCKER_IDENTITY_MISMATCH",
                  context: {
                    containerName,
                    containerId: createdContainerId,
                    headscaleNodeId: registration.nodeId,
                    headscaleIp: registration.ip,
                    containerTailnetIp: containerTailnetIp ?? null,
                    containerTailnetLineCount: containerTailnetLines.length,
                  },
                  ...(lastTailnetQueryError === undefined ? {} : { cause: lastTailnetQueryError }),
                  severity: "fatal",
                },
              );
            }
          } catch (bindingError) {
            // error-policy:J2 exact settlement consumes this explicit
            // unresolved completion instead of treating degraded routing as success.
            markRemoteCompletionUnresolved(bindingError);
            registration = null;
          }
        }
        if (registration && remoteCompletionTracker) {
          const rename = (
            registration as unknown as {
              rename?: { outcome?: unknown; cause?: unknown };
            }
          ).rename;
          switch (rename?.outcome) {
            case "not-needed":
            case "succeeded":
            case "conflict-proven":
              break;
            case "unresolved":
              markRemoteCompletionUnresolved(
                rename.cause ??
                  new ElizaError("Headscale rename completion has no inspectable cause", {
                    code: "HEADSCALE_RENAME_COMPLETION_CAUSE_MISSING",
                    severity: "ephemeral",
                  }),
              );
              break;
            default:
              markRemoteCompletionUnresolved(
                new ElizaError("Headscale rename completion outcome is missing or unknown", {
                  code: "HEADSCALE_RENAME_COMPLETION_UNKNOWN",
                  context: {
                    outcome: typeof rename?.outcome === "string" ? rename.outcome : null,
                  },
                  severity: "ephemeral",
                }),
              );
          }
        }
        if (registration === null) {
          // The pooled SSH channel can be severed or left unusable during the
          // three-minute Headscale wait. Reconnect once and take a longer,
          // synchronous observation while the exact candidate still exists;
          // cleanup immediately below is the last boundary at which Docker,
          // Tailscale, and entrypoint evidence can be read without guessing.
          if (!lastMeshJoinObservation && meshJoinCandidateId) {
            await ssh.disconnect();
            const finalTerminalFailure = await probeDockerMeshJoinTerminalFailure(
              ssh,
              meshJoinCandidateId,
              (observation) => {
                lastMeshJoinObservation = observation;
                lastMeshJoinProbeFailureKind = null;
              },
              (failureKind) => {
                lastMeshJoinProbeFailureKind = failureKind;
              },
              MESH_JOIN_FINAL_PROBE_TIMEOUT_MS,
            );
            if (finalTerminalFailure) markRemoteCompletionUnresolved(finalTerminalFailure);
          }
          if (lastMeshJoinObservation) {
            const closedObservation = formatDockerMeshJoinObservation(lastMeshJoinObservation);
            markRemoteCompletionUnresolved(
              new ElizaError(
                `Docker candidate mesh observation before cleanup: ${closedObservation}`,
                {
                  code: "SANDBOX_MESH_JOIN_OBSERVED",
                  context: { observation: lastMeshJoinObservation },
                  severity: "ephemeral",
                },
              ),
            );
            logger.warn(
              `[docker-sandbox] Docker candidate mesh observation before cleanup: ${closedObservation}`,
            );
          } else if (lastMeshJoinProbeFailureKind) {
            markRemoteCompletionUnresolved(
              new ElizaError(
                `Docker candidate mesh observation unavailable before cleanup: ${lastMeshJoinProbeFailureKind}`,
                {
                  code: "SANDBOX_MESH_JOIN_OBSERVATION_UNAVAILABLE",
                  context: { failureKind: lastMeshJoinProbeFailureKind },
                  severity: "ephemeral",
                },
              ),
            );
            logger.warn(
              `[docker-sandbox] Docker candidate mesh observation unavailable before cleanup: ${lastMeshJoinProbeFailureKind}`,
            );
          }
          markRemoteCompletionUnresolved(
            new ElizaError("Headscale registration did not reach an exact observable completion", {
              code: "HEADSCALE_REGISTRATION_COMPLETION_UNRESOLVED",
              context: { containerName },
              severity: "ephemeral",
            }),
          );
        }
        headscaleIp = registration?.ip ?? null;
        vpnNodeId ??= registration?.nodeId;
        if (headscaleIp) {
          logger.info(
            `[docker-sandbox] Container ${containerName} registered on VPN: ${headscaleIp}`,
          );
        } else {
          logger.warn(
            `[docker-sandbox] VPN registration timeout for ${containerName}, continuing without VPN`,
          );
        }
      } catch (err) {
        markRemoteCompletionUnresolved(err);
        logger.warn(
          `[docker-sandbox] VPN registration failed for ${containerName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Registered node id onto the in-memory meta so teardown can delete
      // THIS container's node by id — by-name is ambiguous while a blue/green
      // overlap shares the hostname (#16565).
      if (vpnNodeId) {
        meta.vpnNodeId = vpnNodeId;
        if (config.onReplacementVpnRegistered) {
          const registeredPort = Number.parseInt(containerPort, 10);
          try {
            await config.onReplacementVpnRegistered({
              sandboxId: containerName,
              bridgeUrl: `http://${headscaleIp}:${registeredPort}`,
              healthUrl: `http://${headscaleIp}:${registeredPort}/api`,
              metadata: {
                provider: "docker",
                nodeId,
                hostname,
                ...replacementPlacementMetadata,
                containerName,
                bridgePort,
                webUiPort,
                agentId,
                volumePath,
                dockerImage: resolvedImage,
                imageDigest: null,
                headscaleIp: headscaleIp ?? undefined,
                vpnNodeId,
                vpnNodeName: vpnEnvVars.TS_HOSTNAME,
                vpnRegistrationStartedAt,
                replacementAttemptId,
                containerId: createdContainerId,
                allocationCounted: Boolean(dbNode),
                previousVpnNodeId,
              } satisfies DockerSandboxMetadata,
            });
          } catch (callbackError) {
            // error-policy:J2 context-adding rethrow — a committed VPN identity
            // must remain attached to the durable cleanup failure.
            throw new SandboxReplacementCleanupUnresolvedError(
              currentCleanupLocator(),
              callbackError,
            );
          }
        }
      }
    }

    if (headscaleRouteRequired && !headscaleIp) {
      const errorMessage =
        "Headscale routing is required, but the sandbox did not register a headscale_ip. " +
        "Refusing to mark the agent running without a routable internal ingress; " +
        "set AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK=1 only for legacy public-host routing.";
      logger.error(`[docker-sandbox] ${errorMessage}`, {
        agentId,
        containerName,
        nodeId,
      });
      if (stewardRegistrationCreated) {
        await deregisterAgentWithSteward(ssh, agentId, stewardTenant)
          .then(() => {
            logger.info(
              `[docker-sandbox] Cleaned up Steward agent ${agentId} after missing Headscale registration`,
            );
          })
          .catch((cleanupErr) => {
            logger.warn(
              `[docker-sandbox] Failed to cleanup Steward agent ${agentId} after missing Headscale registration: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
            );
          });
      }
      if (replacementIntentPersisted) {
        throw new SandboxReplacementCleanupUnresolvedError(
          currentCleanupLocator(),
          requiredHeadscaleIngressFailure(errorMessage, remoteCompletionTracker?.causes ?? []),
        );
      }
      const cleanupLocator = currentCleanupLocator();
      const cleanupNode: DockerNodeConnection = {
        node_id: nodeId,
        hostname,
        ssh_port: sshPort,
        ssh_user: sshUser,
        host_key_fingerprint: hostKeyFingerprint ?? null,
      };
      await this.retireReplacementCandidateOnNode(cleanupLocator, cleanupNode);
      this.containers.delete(containerName);
      if (dbNode && providerManagesCapacity) {
        await dockerNodesRepository.decrementAllocated(nodeId).catch((rollbackError) => {
          // error-policy:J6 best-effort teardown — the candidate is already absent;
          // capacity reconciliation remains observable while the original failure surfaces.
          logger.error(
            `[docker-sandbox] Failed to roll back allocation for node ${nodeId} after unroutable candidate cleanup: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        });
      }
      throw new Error(errorMessage);
    }

    // 10. Return handle with strongly-typed metadata
    const targetHost = headscaleIp || hostname;

    // Probe ghcr.io for the image's current digest so the fleet-upgrade
    // reconciler can detect when the tag has been republished. Returns null
    // on bare image names or registry errors — both are treated as
    // "unknown, leave alone" by the reconciler.
    const imageDigest = await resolveImageDigest(resolvedImage);

    const metadata: DockerSandboxMetadata = {
      provider: "docker",
      nodeId,
      hostname,
      ...replacementPlacementMetadata,
      nodeSshPort: sshPort,
      nodeSshUser: sshUser,
      nodeHostKeyFingerprint: hostKeyFingerprint,
      containerName,
      bridgePort,
      webUiPort,
      agentId,
      volumePath,
      dockerImage: resolvedImage,
      imageDigest,
      headscaleIp: headscaleIp || undefined,
      vpnNodeId,
      vpnNodeName: vpnEnvVars.TS_HOSTNAME,
      vpnRegistrationStartedAt,
      replacementAttemptId,
      containerId: createdContainerId,
      allocationCounted: Boolean(dbNode),
      previousVpnNodeId,
    };

    // Over the headscale mesh the agent-router and the daemon's runtime calls
    // reach the CONTAINER directly at its tailnet IP, where only the container-
    // internal port is bound (the app binds 0.0.0.0:${containerPort}).
    // bridge_port / web_ui_port are the HOST-published ports from
    // `docker -p host:container`; they don't exist inside the container's
    // network namespace, so they only work for host-routing compatibility. bridge_url
    // and health_url are the single source of truth for reaching the agent —
    // encode the port that is actually reachable over the chosen ingress.
    const containerPortNum = Number.parseInt(containerPort, 10);
    const bridgeUrlPort = headscaleIp ? containerPortNum : bridgePort;
    const webUiUrlPort = headscaleIp ? containerPortNum : webUiPort;

    const handle: SandboxHandle = {
      sandboxId: containerName,
      bridgeUrl: `http://${targetHost}:${bridgeUrlPort}`,
      healthUrl: `http://${targetHost}:${webUiUrlPort}/api`,
      metadata: { ...metadata },
    };
    return handle;
  }

  private async provisionAutoscaledNodeForAgent(
    {
      image,
      platform,
      requiredMemoryMb,
    }: {
      image: string;
      platform?: string;
      requiredMemoryMb: number;
    },
    remoteCompletionTracker?: RemoteCompletionTracker,
  ): Promise<DockerNode | null> {
    const env = getCloudAwareEnv();
    const hcloudToken = containersEnv.hetznerCloudToken();
    const publicKey = env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY?.trim();
    if (!hcloudToken || !publicKey) {
      logger.warn("[docker-sandbox] No Docker capacity and autoscale is not configured", {
        hasHcloudToken: Boolean(hcloudToken),
        hasPublicKey: Boolean(publicKey),
      });
      return null;
    }

    try {
      logger.info("[docker-sandbox] No reachable Docker capacity; provisioning autoscaled node", {
        image,
        platform,
      });
      const provisioned = await getNodeAutoscaler().provisionNode(
        {
          // A single paying Dedicated agent must cover its newly purchased
          // node without relying on future users filling a larger server.
          serverType: "ccx13",
          capacity: 1,
          prePullImages: [image],
          labels: { purpose: "agent-provisioning" },
        },
        {
          controlPlanePublicKey: publicKey,
          registrationUrl: env.CONTAINERS_BOOTSTRAP_CALLBACK_URL,
          registrationSecret: env.CONTAINERS_BOOTSTRAP_SECRET,
        },
      );

      const deadline = Date.now() + AUTOSCALED_NODE_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const node = await dockerNodesRepository.findByNodeId(provisioned.nodeId);
        if (
          node &&
          (await dockerNodeManager.ensureNodeReady(node, {
            requiredPlatform: platform,
            ...(requiredMemoryMb > 0 ? { requiredMemoryMb } : {}),
          }))
        ) {
          logger.info("[docker-sandbox] Autoscaled Docker node is ready", {
            nodeId: node.node_id,
            hostname: node.hostname,
          });
          return node;
        }
        await new Promise((resolve) => setTimeout(resolve, AUTOSCALED_NODE_READY_POLL_MS));
      }

      logger.warn("[docker-sandbox] Autoscaled Docker node did not become ready before timeout", {
        nodeId: provisioned.nodeId,
        hostname: provisioned.hostname,
      });
      remoteCompletionTracker?.causes.push(
        new ElizaError("Autoscaled Docker node readiness did not reach exact completion", {
          code: "DOCKER_AUTOSCALE_READINESS_UNRESOLVED",
          context: { nodeId: provisioned.nodeId },
          severity: "ephemeral",
        }),
      );
      return null;
    } catch (error) {
      // error-policy:J4 legacy provisioning keeps its best-effort fallback;
      // exact-success retains the ambiguous provisioning cause in its tracker.
      remoteCompletionTracker?.causes.push(error);
      logger.warn("[docker-sandbox] Autoscaled Docker node provisioning failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ------------------------------------------------------------------
  // stop
  // ------------------------------------------------------------------

  /**
   * Stop and remove a container on a specific node using explicit node info.
   * Used by the fleet-upgrade handler to tear down the old container AFTER
   * the blue/green swap has already updated the agent_sandboxes row to point
   * at the blue — at which point `this.containers` and the DB both resolve
   * to the blue, so the regular `stop(sandboxId)` would target the wrong
   * container.
   *
   * Best-effort: a swap that already redirected traffic doesn't break if we
   * leave a zombie on the old node; the next reconciliation pass plus the
   * autoscaler's idle-node drain handle eventual cleanup. We still try
   * stop+rm with graceful drain so users on websockets get a SIGTERM rather
   * than an abrupt kill.
   */
  async stopOnSpecificNode(
    node: DockerNode,
    containerName: string,
    gracefulSeconds = 30,
  ): Promise<void> {
    await this.stopOnSpecificNodeWithPolicy(node, containerName, gracefulSeconds, true, true);
  }

  async stopOnSpecificNodeForReplacement(
    nodeId: string,
    containerName: string,
    vpnNodeId?: string | null,
    identity?: Omit<
      SandboxReplacementCleanupLocator,
      "sandboxId" | "nodeId" | "containerName" | "vpnNodeId"
    >,
  ): Promise<void> {
    const locator: SandboxReplacementCleanupLocator = {
      ...identity,
      sandboxId: containerName,
      nodeId,
      containerName,
      vpnNodeId,
    };
    let node: DockerNodeConnection;
    try {
      node = await this.resolveReplacementCleanupNode(locator);
    } catch (error) {
      // error-policy:J2 preserve the caller's exact locator for reconciliation.
      throw new SandboxReplacementCleanupUnresolvedError(locator, error);
    }
    await this.retireReplacementCandidateOnNode(locator, node);
  }

  private async resolveReplacementCleanupNode(
    locator: SandboxReplacementCleanupLocator,
  ): Promise<DockerNodeConnection> {
    const exactAuthorityValues = [
      locator.nodeRecordId,
      locator.nodeIncarnation,
      locator.nodeHistoryId,
      locator.nodeHostname,
      locator.nodeSshPort,
      locator.nodeSshUser,
      locator.nodeHostKeyFingerprint,
      locator.replacementSecretCleanupVersion,
    ];
    const hasAnyExactAuthority = exactAuthorityValues.some(
      (value) => value !== undefined && value !== null,
    );
    if (!hasAnyExactAuthority) {
      const legacyNode = await dockerNodesRepository.findByNodeId(locator.nodeId);
      if (!legacyNode) {
        throw new ElizaError(`[docker-sandbox] Node ${locator.nodeId} is not registered`, {
          code: "SANDBOX_REPLACEMENT_NODE_NOT_REGISTERED",
          context: { nodeId: locator.nodeId, containerName: locator.containerName },
          severity: "fatal",
        });
      }
      return legacyNode;
    }

    assertSandboxReplacementAttemptId(locator.replacementAttemptId);

    const nodeRecordId = locator.nodeRecordId;
    if (
      !isCanonicalExactReplacementLocator(locator) ||
      !isCanonicalNodeAuthorityUuid(nodeRecordId)
    ) {
      throw new ElizaError("Exact replacement cleanup node authority is incomplete", {
        code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_INVALID",
        context: { nodeId: locator.nodeId, nodeRecordId: locator.nodeRecordId ?? null },
        severity: "fatal",
      });
    }

    const node = await dockerNodesRepository.findByIdOnPrimary(nodeRecordId);
    if (!node) {
      throw new ElizaError("Exact replacement cleanup node record is no longer registered", {
        code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_MISSING",
        context: { nodeId: locator.nodeId, nodeRecordId },
        severity: "fatal",
      });
    }
    const drifted = [
      ["nodeId", node.node_id, locator.nodeId],
      ...(locator.nodeIncarnation === undefined || locator.nodeIncarnation === null
        ? []
        : [["nodeIncarnation", node.node_incarnation, locator.nodeIncarnation]]),
      ...(locator.nodeHistoryId === undefined || locator.nodeHistoryId === null
        ? []
        : [["nodeHistoryId", node.current_node_history_id, locator.nodeHistoryId]]),
      ["nodeHostname", node.hostname, locator.nodeHostname],
      ["nodeSshPort", node.ssh_port, locator.nodeSshPort],
      ["nodeSshUser", node.ssh_user, locator.nodeSshUser],
      ["nodeHostKeyFingerprint", node.host_key_fingerprint, locator.nodeHostKeyFingerprint],
    ].find(([, actual, expected]) => actual !== expected);
    if (drifted) {
      throw new ElizaError("Exact replacement cleanup node authority changed", {
        code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_DRIFT",
        context: {
          nodeId: locator.nodeId,
          nodeRecordId: locator.nodeRecordId,
          driftedKey: drifted[0],
        },
        severity: "fatal",
      });
    }
    return node;
  }

  private async stopOnSpecificNodeWithPolicy(
    node: DockerNodeConnection,
    containerName: string,
    gracefulSeconds: number,
    allowUnreachableAbandon: boolean,
    releaseCapacity: boolean,
    exactExecution?: {
      readonly ssh?: DockerSSHClient;
      readonly expectedNodeIncarnation?: string;
    },
  ): Promise<void> {
    const ssh =
      exactExecution?.ssh ??
      DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port ?? DEFAULT_SSH_PORT,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user ?? DEFAULT_SSH_USERNAME,
      );
    const remoteCommand = (command: string): string =>
      exactExecution?.expectedNodeIncarnation
        ? buildExactRestoreDockerBootFencedCommand(exactExecution.expectedNodeIncarnation, command)
        : command;
    let stopErr: unknown;
    let rmErr: unknown;
    try {
      await ssh.exec(
        remoteCommand(`docker stop -t ${gracefulSeconds} ${shellQuote(containerName)}`),
        DOCKER_CMD_TIMEOUT_MS,
      );
    } catch (err) {
      stopErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isAlreadyGoneMessage(msg)) {
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: docker stop failed for ${containerName} on ${node.node_id}: ${msg}`,
        );
      }
    }
    try {
      await ssh.exec(
        remoteCommand(`docker rm -f ${shellQuote(containerName)}`),
        DOCKER_CMD_TIMEOUT_MS,
      );
    } catch (err) {
      rmErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isAlreadyGoneMessage(msg)) {
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: docker rm -f failed for ${containerName} on ${node.node_id}: ${msg}`,
        );
      }
    }

    // Replacement cleanup needs positive `docker rm` evidence: a successful
    // stop leaves a restartable container behind. The permissive post-cutover
    // path keeps its historical best-effort policy, while durable replacement
    // fences reject until removal or canonical Docker absence is observed.
    if (!allowUnreachableAbandon && rmErr) {
      const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      if (!isContainerAbsentMessage(rmMsg)) {
        const stopMsg = stopErr instanceof Error ? stopErr.message : String(stopErr ?? "succeeded");
        throw new Error(
          `[docker-sandbox] Cannot prove ${containerName} absent on ${node.node_id}: ` +
            `docker stop -> ${stopMsg}; docker rm -f -> ${rmMsg}`,
        );
      }
    } else if (stopErr && rmErr) {
      const stopMsg = stopErr instanceof Error ? stopErr.message : String(stopErr);
      const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      const stopIsGone = isAlreadyGoneMessage(stopMsg);
      const rmIsGone = isAlreadyGoneMessage(rmMsg);
      if (!stopIsGone && !rmIsGone) {
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: both stop and rm failed for ${containerName} on ${node.node_id}; leaving allocated_count intact (possible zombie) — stop -> ${stopMsg}; rm -> ${rmMsg}`,
        );
        return;
      }
    }

    if (releaseCapacity) {
      await dockerNodesRepository.decrementAllocated(node.node_id).catch((err) => {
        // error-policy:J6 best-effort teardown — remote absence is already proven,
        // so a bookkeeping failure is logged for reconciliation rather than reviving it.
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: decrement allocated_count failed for ${node.node_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  private async retireReplacementCandidateOnNode(
    locator: SandboxReplacementCleanupLocator,
    node: DockerNodeConnection,
  ): Promise<void> {
    let exactCleanupSsh: DockerSSHClient | null = null;
    let ownsExactCleanupSsh = false;
    const exactCleanupCommand = (command: string): string => {
      if (locator.restoreAttemptId === undefined || locator.restoreAttemptId === null) {
        return command;
      }
      if (!isCanonicalNodeAuthorityUuid(locator.nodeIncarnation)) {
        throw new ElizaError("Exact restore cleanup lacks a canonical node boot fence", {
          code: "SANDBOX_EXACT_RESTORE_CLEANUP_BOOT_FENCE_INVALID",
          severity: "fatal",
        });
      }
      return buildExactRestoreBootFencedCommand(locator.nodeIncarnation, command);
    };
    const exactCleanupDockerCommand = (command: string): string => {
      if (locator.restoreAttemptId === undefined || locator.restoreAttemptId === null) {
        return command;
      }
      if (!isCanonicalNodeAuthorityUuid(locator.nodeIncarnation)) {
        throw new ElizaError("Exact restore cleanup lacks a canonical node boot fence", {
          code: "SANDBOX_EXACT_RESTORE_CLEANUP_BOOT_FENCE_INVALID",
          severity: "fatal",
        });
      }
      return buildExactRestoreDockerBootFencedCommand(locator.nodeIncarnation, command);
    };
    try {
      let observedCandidateId: string | null = null;
      let dockerCreateQuiescent = false;
      if (locator.replacementSecretCleanupVersion === 1 && locator.replacementAttemptId) {
        const isExactRestore =
          locator.restoreAttemptId !== undefined && locator.restoreAttemptId !== null;
        const ssh = isExactRestore
          ? DockerSSHClient.createDedicated(
              node.hostname,
              node.ssh_port ?? DEFAULT_SSH_PORT,
              node.host_key_fingerprint ?? undefined,
              node.ssh_user ?? DEFAULT_SSH_USERNAME,
            )
          : DockerSSHClient.getClient(
              node.hostname,
              node.ssh_port ?? DEFAULT_SSH_PORT,
              node.host_key_fingerprint ?? undefined,
              node.ssh_user ?? DEFAULT_SSH_USERNAME,
            );
        ownsExactCleanupSsh = isExactRestore;
        exactCleanupSsh = ssh;
        // Tombstone first, under the same remote flock used by both plaintext
        // producers. The receipt proves the attempt cannot start again and its
        // plaintext files are absent. It intentionally does NOT claim that an
        // already-submitted Docker daemon request cannot materialize later;
        // id-less absence settles only with a quiescent producer marker or a
        // durable exact candidate observation from an earlier cleanup pass.
        const cleanupReceipt = await ssh.exec(
          exactCleanupCommand(
            buildReplacementSecretArtifactsCleanupCommand(
              locator.containerName,
              locator.replacementAttemptId,
              exactRestoreVolumePathFromCleanupLocator(locator),
            ),
          ),
          DOCKER_CMD_TIMEOUT_MS,
        );
        const expectedReceipt = getReplacementSecretArtifactsCleanupReceipt(
          locator.replacementAttemptId,
        );
        const expectedQuiescentReceipt = getReplacementDockerCreateQuiescentReceipt(
          locator.replacementAttemptId,
        );
        const receiptLines = cleanupReceipt.trim().split(/\r?\n/).filter(Boolean);
        if (receiptLines.shift() !== expectedReceipt) {
          throw new ElizaError(
            `[docker-sandbox] Replacement secret cleanup receipt was missing or malformed for ${locator.containerName}`,
            {
              code: "SANDBOX_REPLACEMENT_SECRET_CLEANUP_RECEIPT_INVALID",
              context: {
                containerName: locator.containerName,
                replacementAttemptId: locator.replacementAttemptId,
              },
              severity: "fatal",
            },
          );
        }
        for (const receiptLine of receiptLines) {
          if (receiptLine === expectedQuiescentReceipt && !dockerCreateQuiescent) {
            dockerCreateQuiescent = true;
            continue;
          }
          const candidatePrefix = `ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1 ${locator.replacementAttemptId} `;
          const candidateId = receiptLine.startsWith(candidatePrefix)
            ? receiptLine.slice(candidatePrefix.length)
            : null;
          if (
            candidateId &&
            observedCandidateId === null &&
            isCanonicalDockerContainerId(candidateId) &&
            receiptLine ===
              getReplacementCandidateObservedReceipt(locator.replacementAttemptId, candidateId)
          ) {
            observedCandidateId = candidateId;
            continue;
          }
          throw new ElizaError(
            `[docker-sandbox] Replacement cleanup state receipt was malformed for ${locator.containerName}`,
            {
              code: "SANDBOX_REPLACEMENT_CLEANUP_STATE_RECEIPT_INVALID",
              context: {
                containerName: locator.containerName,
                replacementAttemptId: locator.replacementAttemptId,
              },
              severity: "fatal",
            },
          );
        }
        if (
          locator.containerId &&
          observedCandidateId &&
          !dockerContainerIdsMatch(locator.containerId, observedCandidateId)
        ) {
          throw new ElizaError(
            `[docker-sandbox] Replacement candidate proof conflicts with the persisted Docker id for ${locator.containerName}`,
            {
              code: "SANDBOX_REPLACEMENT_CANDIDATE_PROOF_CONFLICT",
              context: {
                containerName: locator.containerName,
                replacementAttemptId: locator.replacementAttemptId,
                persistedContainerId: locator.containerId,
                observedCandidateId,
              },
              severity: "fatal",
            },
          );
        }
      }
      const cleanupTarget = locator.replacementAttemptId
        ? await this.resolveReplacementContainerForCleanup(
            locator,
            node,
            {
              observedCandidateId,
              dockerCreateQuiescent,
            },
            exactCleanupSsh ?? undefined,
          )
        : locator.containerName;
      if (cleanupTarget) {
        if (
          locator.replacementSecretCleanupVersion === 1 &&
          locator.replacementAttemptId &&
          !locator.containerId &&
          !observedCandidateId
        ) {
          if (!exactCleanupSsh) {
            throw new ElizaError(
              `[docker-sandbox] Exact replacement cleanup SSH authority is unavailable for ${locator.containerName}`,
              {
                code: "SANDBOX_REPLACEMENT_CLEANUP_SSH_AUTHORITY_UNAVAILABLE",
                context: {
                  nodeId: locator.nodeId,
                  containerName: locator.containerName,
                  replacementAttemptId: locator.replacementAttemptId,
                },
                severity: "fatal",
              },
            );
          }
          const observationReceipt = await exactCleanupSsh.exec(
            exactCleanupCommand(
              buildReplacementCandidateObservedCommand(locator.replacementAttemptId, cleanupTarget),
            ),
            DOCKER_CMD_TIMEOUT_MS,
          );
          const expectedObservationReceipt = getReplacementCandidateObservedReceipt(
            locator.replacementAttemptId,
            cleanupTarget,
          );
          if (observationReceipt.trim() !== expectedObservationReceipt) {
            throw new ElizaError(
              `[docker-sandbox] Replacement candidate observation receipt was missing or malformed for ${locator.containerName}`,
              {
                code: "SANDBOX_REPLACEMENT_CANDIDATE_OBSERVATION_RECEIPT_INVALID",
                context: {
                  containerName: locator.containerName,
                  replacementAttemptId: locator.replacementAttemptId,
                  observedCandidateId: cleanupTarget,
                },
                severity: "fatal",
              },
            );
          }
        }
        await this.stopOnSpecificNodeWithPolicy(node, cleanupTarget, 10, false, false, {
          ssh: exactCleanupSsh ?? undefined,
          expectedNodeIncarnation:
            locator.restoreAttemptId === undefined || locator.restoreAttemptId === null
              ? undefined
              : (locator.nodeIncarnation ?? undefined),
        });
      }
      const restoreVolumePath = exactRestoreVolumePathFromCleanupLocator(locator);
      if (restoreVolumePath !== undefined) {
        if (!exactCleanupSsh || !locator.replacementAttemptId) {
          throw new ElizaError("Exact restore staging cleanup SSH authority is unavailable", {
            code: "SANDBOX_EXACT_RESTORE_STAGING_CLEANUP_SSH_AUTHORITY_UNAVAILABLE",
            severity: "fatal",
          });
        }
        const volumeCleanupReceipt = await exactCleanupSsh.exec(
          exactCleanupDockerCommand(
            buildExactRestoreStagingVolumeCleanupCommand(
              locator.containerName,
              locator.replacementAttemptId,
              restoreVolumePath,
            ),
          ),
          DOCKER_CMD_TIMEOUT_MS,
        );
        const expectedVolumeCleanupReceipt = getExactRestoreStagingVolumeCleanupReceipt(
          locator.replacementAttemptId,
          locator.restoreAttemptId!,
        );
        if (volumeCleanupReceipt.trim() !== expectedVolumeCleanupReceipt) {
          throw new ElizaError("Exact restore staging cleanup receipt was missing or malformed", {
            code: "SANDBOX_EXACT_RESTORE_STAGING_CLEANUP_RECEIPT_INVALID",
            context: {
              containerName: locator.containerName,
              replacementAttemptId: locator.replacementAttemptId,
            },
            severity: "fatal",
          });
        }
      }
      if (locator.vpnNodeId) {
        if (!isCanonicalHeadscaleNodeId(locator.vpnNodeId)) {
          throw new ElizaError(
            `[docker-sandbox] Cannot clean invalid Headscale node id ${JSON.stringify(locator.vpnNodeId)}`,
            {
              code: "SANDBOX_REPLACEMENT_HEADSCALE_NODE_ID_INVALID",
              context: {
                containerName: locator.containerName,
                vpnNodeId: locator.vpnNodeId,
              },
              severity: "fatal",
            },
          );
        }
        await withTimeout(
          headscaleClient.deleteNode(locator.vpnNodeId),
          HEADSCALE_CLEANUP_TIMEOUT_MS,
          "replacement headscale cleanup",
        );
        const remainingNodes = await withTimeout(
          headscaleClient.listNodesStrict(),
          HEADSCALE_CLEANUP_TIMEOUT_MS,
          "replacement headscale cleanup proof",
        );
        for (const node of remainingNodes) assertCanonicalHeadscaleNode(node);
        if (remainingNodes.some((node) => node.id === locator.vpnNodeId)) {
          throw new ElizaError(
            `[docker-sandbox] Cannot prove Headscale node ${locator.vpnNodeId} absent after cleanup`,
            {
              code: "SANDBOX_REPLACEMENT_HEADSCALE_RETIREMENT_UNPROVEN",
              context: {
                containerName: locator.containerName,
                vpnNodeId: locator.vpnNodeId,
              },
              severity: "fatal",
            },
          );
        }
      } else if (locator.vpnNodeName) {
        if (locator.replacementSecretCleanupVersion === 1 && locator.containerId) {
          throw new ElizaError(
            "Exact replacement VPN cleanup requires a durable Headscale node ID",
            {
              code: "SANDBOX_REPLACEMENT_VPN_NODE_ID_UNRESOLVED",
              context: {
                containerName: locator.containerName,
                replacementAttemptId: locator.replacementAttemptId ?? null,
                vpnNodeName: locator.vpnNodeName,
              },
              severity: "fatal",
            },
          );
        }
        // An id-less exact Docker intent cannot have reached `docker start`:
        // start happens only after create returns an id and the created-stage
        // callback completes. Once its stopped candidate is retired above,
        // there is therefore no Headscale registration to reclaim. Legacy
        // locators lack that sequencing contract and keep the bounded lookup.
        if (locator.replacementSecretCleanupVersion !== 1) {
          await this.retireReplacementVpnByRegistration(locator);
        }
      }
    } catch (error) {
      // error-policy:J2 context-adding rethrow — the exact persisted locator is
      // required to retry cleanup without guessing at remote identities.
      throw new SandboxReplacementCleanupUnresolvedError(locator, error);
    } finally {
      if (ownsExactCleanupSsh && exactCleanupSsh) {
        await exactCleanupSsh.disconnect().catch((error) => {
          logger.warn(
            `[docker-sandbox] exact replacement cleanup SSH disconnect failed for ${locator.containerName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  private async resolveReplacementContainerForCleanup(
    locator: SandboxReplacementCleanupLocator,
    node: DockerNodeConnection,
    remoteProof: {
      observedCandidateId: string | null;
      dockerCreateQuiescent: boolean;
    },
    exactSsh?: DockerSSHClient,
  ): Promise<string | null> {
    const ssh =
      exactSsh ??
      DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port ?? DEFAULT_SSH_PORT,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user ?? DEFAULT_SSH_USERNAME,
      );
    const remoteCommand = (command: string): string =>
      locator.restoreAttemptId !== undefined && locator.restoreAttemptId !== null
        ? buildExactRestoreDockerBootFencedCommand(locator.nodeIncarnation!, command)
        : command;
    const format = `{{.Id}}|{{index .Config.Labels "${REPLACEMENT_ATTEMPT_LABEL}"}}|{{.Name}}|{{.Created}}`;
    // When Docker returned the create id before a later phase failed, inspect
    // that immutable object directly. A same-name replacement can never make
    // the old id look present or authorize deleting the newer occupant.
    const inspectTarget =
      locator.containerId ?? remoteProof.observedCandidateId ?? locator.containerName;
    let output: string;
    try {
      output = await ssh.exec(
        remoteCommand(`docker inspect --format ${shellQuote(format)} ${shellQuote(inspectTarget)}`),
        DOCKER_CMD_TIMEOUT_MS,
      );
    } catch (error) {
      // error-policy:J3 untrusted Docker response classification — only canonical
      // container absence becomes null; every ambiguous transport failure rethrows.
      const message = error instanceof Error ? error.message : String(error);
      if (isContainerAbsentMessage(message)) {
        if (
          locator.replacementSecretCleanupVersion === 1 &&
          !locator.containerId &&
          !remoteProof.observedCandidateId &&
          !remoteProof.dockerCreateQuiescent
        ) {
          throw new ElizaError(
            `[docker-sandbox] Cannot prove id-less replacement ${locator.containerName} absent: an interrupted Docker create may still materialize`,
            {
              code: "SANDBOX_REPLACEMENT_DOCKER_CREATE_UNRESOLVED",
              context: {
                nodeId: locator.nodeId,
                containerName: locator.containerName,
                replacementAttemptId: locator.replacementAttemptId ?? null,
              },
              severity: "fatal",
            },
          );
        }
        return null;
      }
      throw error;
    }

    const lines = output
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    if (lines.length !== 1) {
      throw new Error(
        `[docker-sandbox] Cannot verify replacement identity for ${locator.containerName}: expected one inspect record`,
      );
    }
    const fields = lines[0]!.split("|");
    if (fields.length !== 4 || fields[0]!.trim().length === 0) {
      throw new Error(
        `[docker-sandbox] Cannot verify replacement identity for ${locator.containerName}: malformed inspect record`,
      );
    }
    const containerId = fields[0]!.trim();
    const attemptId = fields[1]!.trim();
    const observedName = fields[2]!.trim().replace(/^\//, "");
    const observedCreatedAt = Date.parse(fields[3]!.trim());
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new Error(
        `[docker-sandbox] Cannot verify replacement identity for ${locator.containerName}: invalid Docker id`,
      );
    }
    if (
      remoteProof.observedCandidateId &&
      !dockerContainerIdsMatch(remoteProof.observedCandidateId, containerId)
    ) {
      throw new ElizaError(
        `[docker-sandbox] Replacement candidate proof id mismatch for ${locator.containerName}`,
        {
          code: "SANDBOX_REPLACEMENT_CANDIDATE_ID_MISMATCH",
          context: {
            containerName: locator.containerName,
            observedCandidateId: remoteProof.observedCandidateId,
            inspectedContainerId: containerId,
          },
          severity: "fatal",
        },
      );
    }
    if (attemptId !== locator.replacementAttemptId) {
      if (locator.replacementSecretCleanupVersion === 1) {
        throw new ElizaError(
          `[docker-sandbox] Exact replacement attempt label mismatch for ${locator.containerName}`,
          {
            code: "SANDBOX_REPLACEMENT_EXACT_ATTEMPT_LABEL_MISMATCH",
            context: {
              containerName: locator.containerName,
              expectedAttemptId: locator.replacementAttemptId ?? null,
              observedAttemptId: attemptId || null,
            },
            severity: "fatal",
          },
        );
      }
      // A timeout before Docker returned an id leaves only the deterministic
      // name + attempt label as identity. If that name is now occupied by a
      // DIFFERENT attempt, Docker's name uniqueness proves the unknown target
      // is no longer at that name. Retain the occupant and converge the stale
      // cleanup fence; the node-wide orphan reconciler remains responsible for
      // any independently renamed debris. With an immutable id, a label
      // mismatch is corruption and stays fail-closed.
      if (!locator.containerId) {
        logger.warn(
          "[docker-sandbox] Replacement cleanup name is occupied by a different attempt; retaining occupant and treating the id-less target as absent",
          {
            nodeId: locator.nodeId,
            containerName: locator.containerName,
            expectedAttemptId: locator.replacementAttemptId,
            observedAttemptId: attemptId || null,
          },
        );
        return null;
      }
      // With an immutable id the inspect was addressed at the exact persisted
      // object, so a label mismatch cannot be a name reuse — it is attempt-id
      // drift between the fence row and the container's create-time label
      // (#18032). Refusing forever wedges the agent out of every exclusive
      // lifecycle job, so converge once identity is proven by the stronger
      // signals: the id matches the fence record, the deterministic name
      // matches, and the container is old enough that no concurrent
      // replacement attempt can still be mid-write.
      if (
        dockerContainerIdsMatch(locator.containerId, containerId) &&
        observedName === locator.containerName &&
        Number.isFinite(observedCreatedAt) &&
        this.now() - observedCreatedAt >= REPLACEMENT_LABEL_MISMATCH_RETIRE_GRACE_MS
      ) {
        logger.warn(
          "[docker-sandbox] Replacement attempt label drifted from the fence record; converging via id+name identity past the grace window",
          {
            nodeId: locator.nodeId,
            containerName: locator.containerName,
            containerId,
            expectedAttemptId: locator.replacementAttemptId,
            observedAttemptId: attemptId || null,
            containerAgeMs: this.now() - observedCreatedAt,
          },
        );
        return containerId;
      }
      throw new Error(
        `[docker-sandbox] Replacement attempt label mismatch for ${locator.containerName}`,
      );
    }
    if (locator.containerId && !dockerContainerIdsMatch(locator.containerId, containerId)) {
      throw new Error(
        `[docker-sandbox] Replacement container id mismatch for ${locator.containerName}`,
      );
    }
    return containerId;
  }

  private async retireReplacementVpnByRegistration(
    locator: SandboxReplacementCleanupLocator,
  ): Promise<void> {
    const baseName = locator.vpnNodeName;
    if (!baseName) {
      throw new Error(
        `[docker-sandbox] Cannot recover VPN identity for ${locator.containerName} without a node name`,
      );
    }
    if (!locator.vpnRegistrationStartedAt) {
      throw new Error(
        `[docker-sandbox] Cannot recover VPN identity for ${locator.containerName} without a registration start time`,
      );
    }
    const startedAt = Date.parse(locator.vpnRegistrationStartedAt);
    if (!Number.isFinite(startedAt)) {
      throw new Error(
        `[docker-sandbox] Cannot recover VPN identity for ${locator.containerName}: invalid registration start time`,
      );
    }
    const registrationDeadline =
      startedAt + DEFAULT_REGISTRATION_TIMEOUT_MS + REPLACEMENT_VPN_CLOCK_SKEW_ALLOWANCE_MS;
    if (this.now() < registrationDeadline) {
      throw new Error(
        `[docker-sandbox] VPN registration window remains open for ${locator.containerName} until ${new Date(registrationDeadline).toISOString()}`,
      );
    }

    let consecutiveEmptyObservations = 0;
    for (let observation = 0; observation < REPLACEMENT_VPN_SETTLE_OBSERVATIONS; observation += 1) {
      const nodes = await withTimeout(
        headscaleClient.listNodesStrict(),
        HEADSCALE_CLEANUP_TIMEOUT_MS,
        "replacement headscale lookup",
      );
      for (const node of nodes) assertCanonicalHeadscaleNode(node);
      const candidates = nodes.filter((node) => {
        if (node.id === locator.previousVpnNodeId) {
          return false;
        }
        const suffix = node.name.startsWith(`${baseName}-`)
          ? node.name.slice(baseName.length + 1)
          : null;
        const nameMatches =
          node.name === baseName || (suffix !== null && /^[a-z0-9]{8}$/.test(suffix));
        if (!nameMatches) {
          return false;
        }
        const createdAt = Date.parse(node.createdAt);
        if (!Number.isFinite(createdAt)) {
          throw new Error(
            `[docker-sandbox] Cannot classify Headscale node ${node.id}: invalid createdAt`,
          );
        }
        // Headscale may stamp the registration on a different host clock. Bound
        // both sides of the exact registration window: retries can legitimately
        // create several same-intent nodes, while a later lifecycle generation
        // must never be captured merely because it reused the deterministic name.
        return (
          createdAt >= startedAt - REPLACEMENT_VPN_CLOCK_SKEW_ALLOWANCE_MS &&
          createdAt <= registrationDeadline
        );
      });

      if (candidates.length > REPLACEMENT_VPN_MAX_RECOVERABLE_REGISTRATIONS) {
        throw new Error(
          `[docker-sandbox] Cannot recover VPN identity for ${locator.containerName}: matching registration count exceeds the cleanup bound`,
        );
      }
      if (candidates.length > 0) {
        consecutiveEmptyObservations = 0;
        // Every match has the same name fence, belongs to this attempt's closed
        // time window, and excludes the pre-cutover serving node. Retire the
        // whole retry fan-out, then require two later empty observations before
        // releasing the durable cleanup fence.
        for (const candidate of candidates) {
          await withTimeout(
            headscaleClient.deleteNode(candidate.id),
            HEADSCALE_CLEANUP_TIMEOUT_MS,
            "replacement headscale cleanup",
          );
        }
      } else {
        consecutiveEmptyObservations += 1;
      }

      if (observation < REPLACEMENT_VPN_SETTLE_OBSERVATIONS - 1) {
        await this.replacementVpnSettleDelay(REPLACEMENT_VPN_SETTLE_INTERVAL_MS);
      }
    }

    if (consecutiveEmptyObservations < 2) {
      throw new Error(
        `[docker-sandbox] Cannot prove VPN registration settled for ${locator.containerName}`,
      );
    }
  }

  async stopForDeletion(
    sandboxId: string,
    locator?: SandboxDeletionLocator,
  ): Promise<SandboxDeletionStopOutcome> {
    // Deletion is the one teardown whose capacity is owned elsewhere: the
    // caller's deletion generation releases the slot exactly once via
    // `tryReleaseDeletionAllocation`, because this path is retryable and
    // treats either a successful stop or "already gone" as proof that the
    // workload no longer consumes compute (#17185).
    return this.stopWithPolicy(sandboxId, true, false, locator);
  }

  /**
   * Replacement teardown cannot use the delete path's unreachable-node
   * abandonment policy. The old container may resume when its node returns, so
   * an unresolved stop must retain the database fence and block replacement.
   */
  async stopForReplacement(
    sandboxId: string,
    options?: { readonly releaseCapacity?: false },
  ): Promise<void> {
    // Legacy callers retain provider-owned slot release. Paid sleep opts out:
    // its database transaction recounts remaining workloads so a retry after
    // physical removal cannot decrement a live sibling's allocation.
    await this.stopWithPolicy(sandboxId, false, options?.releaseCapacity !== false);
  }

  private async stopWithPolicy(
    sandboxId: string,
    allowUnreachableAbandon: boolean,
    releaseCapacity: boolean,
    deletionLocator?: SandboxDeletionLocator,
  ): Promise<SandboxDeletionStopOutcome> {
    const meta = deletionLocator
      ? await this.teardownMetaFromDeletionLocator(sandboxId, deletionLocator)
      : await this.resolveContainerForTeardown(sandboxId);

    logger.info(
      `[docker-sandbox] Stopping container ${meta.containerName} on ${meta.nodeId} (${meta.hostname})`,
    );

    // Teardown gets an isolated session. A timed-out command can leave an SSH
    // connection alive while its channel is poisoned; keeping that connection
    // in the shared pool made every agent_delete retry inherit the same broken
    // transport even after the container was already absent.
    const ssh = DockerSSHClient.createDedicated(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );

    // Track both attempts so we can fail loudly if neither call landed.
    // Historically these errors were swallowed independently, which let
    // the caller think a delete succeeded while the container kept
    // running on the core (observed in prod e2e on 2026-05-16). We need
    // at least one of (stop, rm) to land for the container to be
    // effectively gone.
    let stopErr: unknown;
    let rmErr: unknown;
    let exactAbsenceProven = false;

    try {
      // Deletion retries commonly arrive after an earlier attempt removed the
      // container but failed in a later database/credential phase. Prove that
      // exact name absent before sending Docker another mutating command. The
      // remote coreutils timeout bounds a wedged Docker CLI independently of
      // the SSH channel timeout; only Docker's explicit no-such-object result
      // authorizes the short-circuit.
      try {
        const target = shellQuote(meta.containerName);
        const probeScript = [
          `probe_output=$(timeout -k 2s 8s docker container inspect --format '{{.Id}}' ${target} 2>&1)`,
          "probe_rc=$?",
          "if [ \"$probe_rc\" -eq 0 ]; then printf 'present\\n'",
          "elif [ \"$probe_rc\" -eq 124 ]; then printf 'unknown\\n'",
          "elif printf '%s' \"$probe_output\" | grep -Eqi 'no such (object|container)'; then printf 'absent\\n'",
          "else printf 'unknown\\n'; fi",
        ].join("; ");
        exactAbsenceProven =
          (
            await ssh.exec(`sh -lc ${shellQuote(probeScript)}`, TEARDOWN_ABSENCE_PROBE_TIMEOUT_MS)
          ).trim() === "absent";
      } catch (probeError) {
        // error-policy:J7 the authoritative stop/rm pair below still owns the
        // mutation verdict; this read-only optimization may safely be unavailable.
        logger.warn("[docker-sandbox] Exact pre-delete absence probe unavailable", {
          nodeId: meta.nodeId,
          containerName: meta.containerName,
          failureKind: classifyDockerSshProbeError(probeError),
        });
      }

      if (exactAbsenceProven) {
        logger.info(
          `[docker-sandbox] Container ${meta.containerName} proven absent before delete mutation`,
        );
      }

      try {
        // Graceful stop with 10s timeout, then force-remove.
        if (!exactAbsenceProven) {
          await ssh.exec(
            `docker stop -t 10 ${shellQuote(meta.containerName)}`,
            STOP_CMD_TIMEOUT_MS,
          );
          logger.info(`[docker-sandbox] Container stopped: ${meta.containerName}`);
        }
      } catch (err) {
        // error-policy:J1 Retain the stop failure for the final teardown verdict;
        // only an authoritative remove or absence result can resolve it.
        stopErr = err;
        logger.warn(
          `[docker-sandbox] docker stop failed for ${meta.containerName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (classifyDockerSshProbeError(err) === "transport") {
          // The stop did not return a remote exit code. Reconnect before the
          // authoritative rm so a stale or poisoned channel cannot consume the
          // entire delete retry budget by being reused unchanged.
          await ssh.disconnect().catch((disconnectError) => {
            // error-policy:J6 best-effort teardown reconnect; rm immediately
            // opens a fresh session and remains the authoritative absence test.
            logger.warn(`[docker-sandbox] Failed to reset teardown SSH session`, {
              nodeId: meta.nodeId,
              containerName: meta.containerName,
              error:
                disconnectError instanceof Error
                  ? disconnectError.message
                  : String(disconnectError),
            });
          });
        }
      }

      try {
        if (!exactAbsenceProven) {
          await ssh.exec(`docker rm -f ${shellQuote(meta.containerName)}`, STOP_CMD_TIMEOUT_MS);
          logger.info(`[docker-sandbox] Container removed: ${meta.containerName}`);
        }
      } catch (err) {
        // error-policy:J1 The final teardown verdict below preserves this
        // remote failure unless recovery proves the exact container absent.
        rmErr = err;
        logger.error(
          `[docker-sandbox] docker rm failed for ${meta.containerName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      await ssh.disconnect().catch((disconnectError) => {
        // error-policy:J6 best-effort teardown session cleanup; stop/rm results
        // above, not disconnect, determine whether absence was proven.
        logger.warn(`[docker-sandbox] Failed to close teardown SSH session`, {
          nodeId: meta.nodeId,
          containerName: meta.containerName,
          error:
            disconnectError instanceof Error ? disconnectError.message : String(disconnectError),
        });
      });
    }

    const stopCommandTimedOut =
      stopErr !== undefined && isDockerSshCommandTimeoutError(stopErr, "docker");
    const rmCommandTimedOut =
      rmErr !== undefined && isDockerSshCommandTimeoutError(rmErr, "docker");
    const stopFailureProvesGone =
      stopErr !== undefined &&
      (allowUnreachableAbandon
        ? isAlreadyGoneMessage(stopErr instanceof Error ? stopErr.message : String(stopErr))
        : isContainerAbsentMessage(stopErr instanceof Error ? stopErr.message : String(stopErr)));
    const rmFailureProvesGone =
      rmErr !== undefined &&
      (allowUnreachableAbandon
        ? isAlreadyGoneMessage(rmErr instanceof Error ? rmErr.message : String(rmErr))
        : isContainerAbsentMessage(rmErr instanceof Error ? rmErr.message : String(rmErr)));
    const dockerSelfHealEnabled = containersEnv.prePullSelfHealRestartEnabled();
    const stopFailureKind =
      stopErr !== undefined ? classifyDockerSshProbeError(stopErr) : undefined;
    const rmFailureKind = rmErr !== undefined ? classifyDockerSshProbeError(rmErr) : undefined;

    if (stopErr && rmErr) {
      logger.warn("[docker-sandbox] Docker teardown recovery decision", {
        nodeId: meta.nodeId,
        containerName: meta.containerName,
        agentId: meta.agentId,
        allowUnreachableAbandon,
        dockerSelfHealEnabled,
        stopCommandTimedOut,
        rmCommandTimedOut,
        stopFailureProvesGone,
        rmFailureProvesGone,
        stopFailureKind,
        rmFailureKind,
      });
    }

    // One exact Docker-command timeout proves that SSH reached the node but the
    // daemon failed to answer. A pair of transport failures can also be a
    // poisoned SSH session, so the isolated recovery connection re-probes
    // Docker. A healthy daemon is never restarted; recovery requires the
    // running daemon to confirm live restore before any restart, then
    // health and exact-name removal are proved. Remote command failures such as
    // auth/permission errors remain ineligible. Production remains protected-off
    // until staging proof.
    if (
      allowUnreachableAbandon &&
      stopErr &&
      rmErr &&
      !stopFailureProvesGone &&
      !rmFailureProvesGone &&
      (stopCommandTimedOut ||
        rmCommandTimedOut ||
        (stopFailureKind === "transport" && rmFailureKind === "transport")) &&
      dockerSelfHealEnabled
    ) {
      const recoverySsh = DockerSSHClient.createDedicated(
        meta.hostname,
        meta.sshPort,
        meta.hostKeyFingerprint,
        meta.sshUser,
      );
      let recoveryStage = "docker_info_probe";
      try {
        logger.error("[docker-sandbox] Docker teardown failed twice; probing daemon recovery", {
          nodeId: meta.nodeId,
          containerName: meta.containerName,
          agentId: meta.agentId,
        });
        const dockerHealth = (
          await recoverySsh.exec(
            "if timeout -k 2s 20s docker info >/dev/null 2>&1; then printf healthy; else printf unavailable; fi",
            TEARDOWN_DOCKER_SELF_HEAL_STAGE_TIMEOUT_MS,
          )
        ).trim();
        if (dockerHealth !== "healthy" && dockerHealth !== "unavailable") {
          throw new ElizaError("Docker recovery returned an invalid health probe result", {
            code: "SANDBOX_DELETION_DOCKER_HEALTH_INVALID",
            context: { nodeId: meta.nodeId, containerName: meta.containerName },
          });
        }
        if (dockerHealth !== "healthy") {
          recoveryStage = "live_restore_proof";
          await recoverySsh.exec(
            buildDockerLiveRestoreProofCommand(),
            TEARDOWN_DOCKER_SELF_HEAL_STAGE_TIMEOUT_MS,
          );
          recoveryStage = "docker_force_stop";
          await recoverySsh.exec(
            "systemctl kill --kill-who=main -s SIGKILL docker.service 2>/dev/null || true; systemctl stop docker.socket 2>/dev/null || true; sleep 2",
            TEARDOWN_DOCKER_SELF_HEAL_STAGE_TIMEOUT_MS,
          );
          recoveryStage = "docker_start";
          await recoverySsh.exec(
            "systemctl reset-failed docker.service 2>/dev/null; systemctl start docker.service",
            TEARDOWN_DOCKER_SELF_HEAL_STAGE_TIMEOUT_MS,
          );
          recoveryStage = "docker_info";
          await recoverySsh.exec(
            "timeout -k 2s 20s docker info >/dev/null",
            TEARDOWN_DOCKER_SELF_HEAL_STAGE_TIMEOUT_MS,
          );
        }
        recoveryStage = "exact_container_remove";
        await recoverySsh.exec(
          `timeout -k 2s 20s docker rm -f ${shellQuote(meta.containerName)}`,
          STOP_CMD_TIMEOUT_MS,
        );
        stopErr = undefined;
        rmErr = undefined;
        logger.info("[docker-sandbox] Docker daemon recovered and container removed", {
          nodeId: meta.nodeId,
          containerName: meta.containerName,
          agentId: meta.agentId,
        });
      } catch (recoveryError) {
        // error-policy:J1 Recovery failure leaves the original stop/remove
        // failures authoritative in the typed teardown result below.
        logger.error("[docker-sandbox] Docker daemon recovery did not prove container removal", {
          nodeId: meta.nodeId,
          containerName: meta.containerName,
          agentId: meta.agentId,
          recoveryStage,
          failureKind: classifyDockerSshProbeError(recoveryError),
        });
      } finally {
        await recoverySsh.disconnect().catch((disconnectError) => {
          // error-policy:J6 the recovery/remove verdict above is authoritative;
          // closing its isolated SSH session is teardown-only cleanup.
          logger.warn("[docker-sandbox] Failed to close daemon-recovery SSH session", {
            nodeId: meta.nodeId,
            containerName: meta.containerName,
            error:
              disconnectError instanceof Error ? disconnectError.message : String(disconnectError),
          });
        });
      }
    }

    let outcome: SandboxDeletionStopOutcome = { kind: "not-running-proven" };
    if (stopErr && rmErr) {
      const stopMsg = stopErr instanceof Error ? stopErr.message : String(stopErr);
      const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      // "No such container" from either call means the container was
      // already gone — that is a success, not a failure. We only escalate
      // when both calls failed for a reason that does NOT indicate the
      // container is absent (SSH down, Docker daemon hung, etc.).
      const stopIsGone = stopFailureProvesGone;
      const rmIsGone = rmFailureProvesGone;
      // An UNREACHABLE node (SSH connect timeout, refused/unreachable socket,
      // DNS failure on BOTH legs) is treated as TERMINAL: the delete is
      // completed instead of re-queued. Re-queuing an unreachable delete re-runs
      // the 20-65s stop path every cycle, which can push the work cycle
      // past the 300s watchdog so the liveness heartbeat is withheld and the
      // cloud-api fails closed (agents API hangs).
      //
      // TRADE-OFF / HONEST LIMITATION: completing the delete here ABANDONS the
      // container. The orphan reconciler retains the deletion generation's
      // capacity ownership until it can inspect the node and prove the workload
      // absent. This prevents the scheduler from packing against capacity that
      // an abandoned container may still consume.
      const unreachable = isNodeUnreachableMessage(stopMsg) && isNodeUnreachableMessage(rmMsg);
      if (!stopIsGone && !rmIsGone && (!unreachable || !allowUnreachableAbandon)) {
        throw new Error(
          `Failed to stop container ${meta.containerName} on ${meta.hostname}: ` +
            `docker stop -> ${stopMsg}; docker rm -f -> ${rmMsg}`,
        );
      }
      if (unreachable) {
        outcome = {
          kind: "not-running-unresolved",
          reason: "node-unreachable",
        };
        logger.warn(
          `[docker-sandbox] Node ${meta.hostname} unreachable during stop of ${meta.containerName}; ` +
            `completing delete while retaining its capacity until reconciliation — ` +
            `docker stop -> ${stopMsg}; docker rm -f -> ${rmMsg}`,
          { nodeId: meta.nodeId, containerName: meta.containerName },
        );
      } else {
        logger.info(
          `[docker-sandbox] Container ${meta.containerName} already absent on ${meta.hostname}`,
        );
      }
    }

    // Capacity release is per-operation, not unconditional. A teardown whose
    // caller owns a durable generation passes `releaseCapacity: false` and
    // hands the slot back itself, because this path is retryable and treats
    // "already absent" as success — so decrementing here would run several
    // times for one allocation and free a live sibling's slot (#17185).
    if (releaseCapacity) {
      await dockerNodesRepository.decrementAllocated(meta.nodeId).catch((err) => {
        // error-policy:J6 best-effort teardown — the workload is already not
        // running; the logged overcount is safe and the periodic recount heals it.
        logger.warn(
          `[docker-sandbox] Failed to decrement allocated_count for node ${meta.nodeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    // Deletes Headscale VPN registration only for containers that were
    // actually enrolled. Fallback-mode containers can run with HEADSCALE_API_KEY
    // configured but without TS_HOSTNAME; deleting by bare agent id can remove a
    // stale or unrelated node.
    const headscaleEnv = currentHeadscaleRouteEnv();
    const registeredNodeName = meta.tsHostname;
    if (shouldCleanupHeadscaleVpn(headscaleEnv, registeredNodeName)) {
      // One pinned decision for every teardown path (#16565): by-id when this
      // container registered, forbidden by-name in preserve mode where the
      // only same-name node is the LIVE preserved one, historical by-name for
      // plain provisions.
      const teardown = resolveVpnTeardown(meta);
      const cleanup =
        teardown.kind === "by-id"
          ? headscaleIntegration.removeVpnNodeById(teardown.nodeId)
          : teardown.kind === "by-name"
            ? headscaleIntegration.cleanupContainerVPN(registeredNodeName)
            : null;
      if (cleanup) {
        await withTimeout(cleanup, HEADSCALE_CLEANUP_TIMEOUT_MS, "headscale cleanup").catch(
          (err) => {
            // error-policy:J6 best-effort teardown — compute teardown is already
            // complete, so VPN cleanup failure is observable without reviving it.
            logger.warn(
              `[docker-sandbox] Headscale cleanup failed for ${meta.agentId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
      } else {
        logger.info(
          `[docker-sandbox] Skipping Headscale cleanup for ${meta.agentId}: preserved live node holds the hostname and this container never registered`,
        );
      }
    }

    // Remove from in-memory registry
    this.containers.delete(meta.containerName);
    return outcome;
  }

  // ------------------------------------------------------------------
  // checkHealth
  // ------------------------------------------------------------------

  /**
   * Poll the agent's health endpoint over the headscale tailnet — the real
   * ingress the agent-router uses. The daemon is a member of the mesh, so it
   * dials the agent's tailnet IP directly. Retries until the app has booted AND
   * the WireGuard/DERP path is warm, or the deadline passes. This is what keeps
   * a freshly-registered container alive long enough to become reachable: the
   * SSH host probe alone passes as soon as the app binds the container's docker
   * bridge (eth0), which happens before the tailnet path is warm, so the first
   * racing tailnet fetch (listRuntimeAgents) would tear a healthy agent down.
   */
  private async pollTailnetHealth(
    handle: SandboxHandle,
    meta: ContainerMeta,
    deadline: number,
  ): Promise<boolean> {
    // handle.healthUrl is `http://<headscaleIp>:<containerPort>/api`; the agent
    // serves liveness at /api/health on that same port.
    const healthUrl = `${handle.healthUrl}/health`;
    logger.info(
      `[docker-sandbox] Polling tailnet health for ${meta.containerName} at ${healthUrl} (timeout: ${HEALTH_CHECK_TIMEOUT_MS / 1000}s)`,
    );

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, {
          method: "GET",
          signal: AbortSignal.timeout(5_000),
        });
        if ([200, 301, 302, 401].includes(res.status)) {
          logger.info(
            `[docker-sandbox] Tailnet health probe passed for ${meta.containerName} (${healthUrl})`,
          );
          await tailnetPathMonitor.record({
            containerName: meta.containerName,
            outcome: "passed",
          });
          return true;
        }
        logger.debug(
          `[docker-sandbox] Tailnet health probe for ${meta.containerName} returned HTTP ${res.status}, retrying...`,
        );
      } catch (err) {
        logger.debug(
          `[docker-sandbox] Tailnet health probe failed for ${meta.containerName}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(HEALTH_CHECK_POLL_INTERVAL_MS, remaining)),
      );
    }

    logger.warn(
      `[docker-sandbox] Tailnet health check timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s for ${meta.containerName} (${healthUrl})`,
    );
    // A run of these across distinct containers is the severed-path signature
    // (headscale ACL regression); the monitor pages ops instead of letting the
    // outage hide inside per-container provisioning retries.
    await tailnetPathMonitor.record({
      containerName: meta.containerName,
      outcome: "timed_out",
    });
    return false;
  }

  /** Resolve only the candidate handle; canonical placement may still name its predecessor. */
  private candidateHealthPlacement(handle: SandboxHandle): ContainerMeta {
    const meta = handle.metadata;
    const validPort = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
    if (
      !meta ||
      meta.provider !== "docker" ||
      typeof meta.nodeId !== "string" ||
      !meta.nodeId.trim() ||
      typeof meta.hostname !== "string" ||
      !meta.hostname.trim() ||
      typeof meta.agentId !== "string" ||
      typeof meta.containerName !== "string" ||
      meta.containerName !== handle.sandboxId ||
      !validPort(meta.bridgePort) ||
      !validPort(meta.webUiPort) ||
      !validPort(meta.nodeSshPort) ||
      typeof meta.nodeSshUser !== "string" ||
      !meta.nodeSshUser.trim() ||
      (meta.nodeHostKeyFingerprint !== undefined && typeof meta.nodeHostKeyFingerprint !== "string")
    ) {
      throw new ElizaError("Candidate health requires complete matching Docker placement", {
        code: "SANDBOX_CANDIDATE_HEALTH_PLACEMENT_INVALID",
      });
    }
    try {
      if (meta.containerName !== getContainerName(meta.agentId)) {
        throw new Error("Candidate container does not match its agent");
      }
    } catch (cause) {
      // error-policy:J3 invalid candidate identity must not fall back to canonical placement.
      throw new ElizaError("Candidate health requires a matching Docker identity", {
        code: "SANDBOX_CANDIDATE_HEALTH_PLACEMENT_INVALID",
        cause,
      });
    }
    return {
      nodeId: meta.nodeId,
      hostname: meta.hostname,
      containerName: meta.containerName,
      agentId: meta.agentId,
      bridgePort: meta.bridgePort,
      webUiPort: meta.webUiPort,
      sshPort: meta.nodeSshPort,
      sshUser: meta.nodeSshUser,
      hostKeyFingerprint: meta.nodeHostKeyFingerprint,
    };
  }

  async checkHealth(handle: SandboxHandle, context?: SandboxHealthContext): Promise<boolean> {
    return (await this.checkHealthDetailed(handle, context)).ready;
  }

  /**
   * Readiness probe that distinguishes a genuine `not_ready` from a
   * `transport_unresolved` exhaustion so callers can treat a probe that never
   * reached the container as RETRYABLE rather than a terminal failure. See
   * {@link SandboxHealthVerdict}.
   */
  async checkHealthDetailed(
    handle: SandboxHandle,
    context: SandboxHealthContext = { kind: "canonical" },
  ): Promise<SandboxHealthOutcome> {
    const meta =
      context.kind === "candidate"
        ? this.candidateHealthPlacement(handle)
        : await this.resolveContainer(handle.sandboxId);
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;

    // When the agent is reachable over the headscale mesh, validate THAT
    // ingress first: the agent-router and the post-create runtime calls reach
    // the agent over the tailnet, and the daemon is itself on the mesh. The SSH
    // host probe only proves the app bound the container's docker bridge, which
    // happens before the tailnet/DERP path is warm — gating on it alone would
    // let the first racing tailnet fetch tear the agent down despite it being
    // healthy.
    const headscaleIp =
      typeof handle.metadata?.headscaleIp === "string" ? handle.metadata.headscaleIp : undefined;
    if (headscaleIp) {
      if (await this.pollTailnetHealth(handle, meta, deadline)) {
        return { ready: true, verdict: "ready" };
      }
      // A cold CP-side mesh socket at provision time can miss every tailnet
      // probe while the container is demonstrably healthy on its node; without
      // this fallback the provision path ghost-kills that healthy container.
      // Node-side Docker health is NOT proof of the managed ingress used by the
      // immediately-following runtime bootstrap calls. Report that split truth
      // explicitly: preserve/retry the healthy workload, but do not declare it
      // ready and then issue a doomed fetch through the same dead tailnet URL.
      const nodeHealth = await this.pollSshDockerHealth(
        meta,
        Date.now() + HEALTH_CHECK_SSH_FALLBACK_TIMEOUT_MS,
        context,
      );
      return nodeHealth.ready ? { ready: false, verdict: "ingress_unresolved" } : nodeHealth;
    }

    return this.pollSshDockerHealth(meta, deadline, context);
  }

  /**
   * Node-side health: SSH to the docker node and pass when either the
   * host-published ports answer or docker reports the container healthy. This
   * is the only ingress evidence available without a headscale route, and the
   * fallback that keeps a provision alive when the CP-side mesh socket is cold
   * while the container itself is healthy.
   */
  private async pollSshDockerHealth(
    meta: ContainerMeta,
    deadline: number,
    context: SandboxHealthContext = { kind: "canonical" },
  ): Promise<SandboxHealthOutcome> {
    // The budget varies by caller (full window standalone, short window as the
    // tailnet fallback), so log the actual one instead of a constant.
    const budgetMs = Math.max(0, deadline - Date.now());
    let current = meta;
    logger.info(
      `[docker-sandbox] Polling Docker health for ${current.containerName} on ${current.nodeId} (${current.hostname}) (timeout: ${Math.round(budgetMs / 1000)}s)`,
    );

    // Track whether THIS probe window ever actually reached the container. Every
    // failure of a single iteration is classified transport-vs-remote (see
    // classifyDockerSshProbeError): if the whole budget is spent and NOTHING
    // ever reached the container (SSH flapping / node briefly unreachable), the
    // verdict is `transport_unresolved` (retryable) — NOT `not_ready`, which
    // would falsely condemn a container the probe never even reached.
    let reachedContainer = false;

    const runOneProbe = async (): Promise<"ready" | "not_ready" | "transport"> => {
      // Established probes follow committed placement changes. A pre-cutover
      // candidate must retain its captured node while the predecessor is canonical.
      if (context.kind === "canonical") current = await this.refreshNodeMeta(current);
      const ssh = DockerSSHClient.getClient(
        current.hostname,
        current.sshPort,
        current.hostKeyFingerprint,
        current.sshUser,
      );
      const inspectCmd = `docker inspect --format '{{.State.Health.Status}}' ${shellQuote(current.containerName)}`;
      const hostProbeCmd = `sh -lc ${shellQuote(
        [
          `for URL in http://127.0.0.1:${current.bridgePort}/api/health http://127.0.0.1:${current.webUiPort}/; do`,
          `STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || true);`,
          `case "$STATUS" in 200|301|302|401) exit 0;; esac;`,
          `done; exit 1`,
        ].join(" "),
      )}`;

      // A single iteration is `transport` ONLY when BOTH sub-probes fail at the
      // SSH transport layer; if either one reaches the container (host probe
      // exits non-zero = curl ran, or the inspect returns a status), we reached
      // it and the iteration is `not_ready`, not `transport`.
      let iterationReached = false;

      try {
        await ssh.exec(hostProbeCmd, Math.min(10_000, HEALTH_CHECK_TIMEOUT_MS));
        logger.info(
          `[docker-sandbox] Host HTTP probe passed for ${current.containerName} on ${current.nodeId}`,
        );
        return "ready";
      } catch (err) {
        const kind = classifyDockerSshProbeError(err);
        if (kind === "remote") iterationReached = true;
        logger.debug(
          `[docker-sandbox] Host HTTP probe failed (${kind}) for ${current.containerName}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const status = (
          await ssh.exec(inspectCmd, Math.min(10_000, HEALTH_CHECK_TIMEOUT_MS))
        ).trim();
        // The inspect returned a status string — we reached the container,
        // whatever the value.
        iterationReached = true;

        if (status === "healthy") {
          logger.info(
            `[docker-sandbox] Docker health check passed for ${current.containerName}: ${status}`,
          );
          return "ready";
        }

        logger.debug(
          `[docker-sandbox] Docker health for ${current.containerName} is ${status || "unknown"}, retrying...`,
        );
      } catch (err) {
        const kind = classifyDockerSshProbeError(err);
        if (kind === "remote") iterationReached = true;
        logger.debug(
          `[docker-sandbox] Docker health inspect failed (${kind}) for ${current.containerName}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (iterationReached) reachedContainer = true;
      return iterationReached ? "not_ready" : "transport";
    };

    while (Date.now() < deadline) {
      const outcome = await runOneProbe();
      if (outcome === "ready") return { ready: true, verdict: "ready" };

      // Wait before retrying (but don't overshoot the deadline)
      const remaining = deadline - Date.now();
      if (remaining > HEALTH_CHECK_POLL_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL_MS));
      } else if (remaining > 0) {
        // One last attempt after a short wait
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
      } else {
        break;
      }
    }

    // The main budget is spent. If we NEVER reached the container, the whole
    // window was transport failures — do NOT condemn the container yet. Retry
    // over a short extra window with capped backoff; a flapping SSH pool or a
    // briefly-unreachable node usually clears in seconds. Only if it STILL only
    // sees transport failures do we report `transport_unresolved` (retryable).
    if (!reachedContainer) {
      const retryDeadline = Date.now() + HEALTH_CHECK_TRANSPORT_RETRY_WINDOW_MS;
      let backoff = HEALTH_CHECK_TRANSPORT_RETRY_BASE_MS;
      logger.warn(
        `[docker-sandbox] Health probe never reached ${current.containerName} on ${current.hostname} within ${Math.round(budgetMs / 1000)}s (transport failures only); retrying transport for up to ${HEALTH_CHECK_TRANSPORT_RETRY_WINDOW_MS / 1000}s before deciding`,
      );
      while (Date.now() < retryDeadline) {
        const outcome = await runOneProbe();
        if (outcome === "ready") return { ready: true, verdict: "ready" };
        // As soon as ANY attempt reaches the container, fall through to the
        // normal not_ready verdict below — the split-brain is resolved.
        if (reachedContainer) break;
        const remaining = retryDeadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoff, remaining)));
        backoff = Math.min(backoff * 2, HEALTH_CHECK_TRANSPORT_RETRY_MAX_MS);
      }

      if (!reachedContainer) {
        logger.warn(
          `[docker-sandbox] Health probe for ${current.containerName} on ${current.hostname} remained transport-unresolved — reporting retryable (NOT marking the container failed)`,
        );
        return { ready: false, verdict: "transport_unresolved" };
      }
    }

    logger.warn(
      `[docker-sandbox] Docker health check timed out after ${Math.round(budgetMs / 1000)}s for ${current.containerName} on ${current.hostname}`,
    );
    const ssh = DockerSSHClient.getClient(
      current.hostname,
      current.sshPort,
      current.hostKeyFingerprint,
      current.sshUser,
    );
    try {
      const diagnostics = await ssh.exec(
        [
          `echo '--- inspect ---'`,
          `docker inspect --format 'state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} exit={{.State.ExitCode}} error={{.State.Error}}' ${shellQuote(current.containerName)} || true`,
          `echo '--- authkey marker ---'`,
          // The entrypoint drops this marker in TS_STATE_DIR when it hits the
          // auth-expired terminal state; a present marker is an unambiguous
          // "needs re-key" signal even if logs have rotated. TS_STATE_DIR is a
          // bind-mounted volume so this survives the container exit.
          `docker exec ${shellQuote(current.containerName)} sh -c 'test -f "\${TS_STATE_DIR:-/var/lib/tailscale}/${TS_AUTHKEY_EXPIRED_MARKER_BASENAME}" && echo authkey-marker=present || echo authkey-marker=absent' 2>/dev/null || echo authkey-marker=unknown`,
          `echo '--- ports ---'`,
          `docker port ${shellQuote(current.containerName)} || true`,
          `echo '--- logs ---'`,
          `docker logs --tail 160 ${shellQuote(current.containerName)} 2>&1 || true`,
        ].join("; "),
        DOCKER_CMD_TIMEOUT_MS,
      );
      logger.warn("[docker-sandbox] Health timeout diagnostics", {
        containerName: current.containerName,
        nodeId: current.nodeId,
        diagnostics,
      });

      // Promote a distinct auth_expired signal when the diagnostics show the
      // container is crash-looping specifically on expired mesh auth. This is
      // observability-only here (the verdict below stays not_ready so existing
      // recreate paths are unchanged), but it gives the control plane a
      // greppable, unambiguous line to drive re-key/recreate instead of
      // treating the loop as a generic health failure.
      const exitMatch = /\bexit=(-?\d+)\b/.exec(diagnostics);
      const meshAuthVerdict = classifyMeshAuthStatus({
        exitCode: exitMatch ? Number.parseInt(exitMatch[1]!, 10) : undefined,
        markerPresent: diagnostics.includes("authkey-marker=present"),
        logs: diagnostics,
      });
      if (meshAuthVerdict === "auth_expired") {
        logger.error(
          "[docker-sandbox] Container failed mesh join: headscale auth key expired/rejected — needs re-key",
          {
            containerName: current.containerName,
            nodeId: current.nodeId,
            meshAuthVerdict,
            authExpiredExitCode: TS_AUTHKEY_EXPIRED_EXIT_CODE,
          },
        );
      }
    } catch (diagnosticsError) {
      logger.warn("[docker-sandbox] Failed to collect health timeout diagnostics", {
        containerName: current.containerName,
        error:
          diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError),
      });
    }
    // We reached the container at least once but it never answered healthy — a
    // genuine not-ready verdict (terminal), not a transport false-negative.
    return { ready: false, verdict: "not_ready" };
  }

  // ------------------------------------------------------------------
  // runCommand
  // ------------------------------------------------------------------

  async runCommand(sandboxId: string, cmd: string, args?: string[]): Promise<string> {
    const meta = await this.resolveContainer(sandboxId);

    // Shell-escape each argument to prevent command injection
    const escapedArgs = args && args.length > 0 ? args.map((a) => shellQuote(a)).join(" ") : "";
    const fullCmd = escapedArgs ? `${shellQuote(cmd)} ${escapedArgs}` : shellQuote(cmd);

    logger.info(
      `[docker-sandbox] Executing command in ${meta.containerName}: ${cmd} ${(args ?? []).join(" ")}`,
    );

    const ssh = DockerSSHClient.getClient(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );
    const output = await ssh.exec(
      `docker exec ${shellQuote(meta.containerName)} ${fullCmd}`,
      DOCKER_CMD_TIMEOUT_MS,
    );

    return output;
  }

  /**
   * SSH `docker logs --tail N <container>` on the assigned core and
   * return the combined stdout/stderr. Used by the `agent_logs` job
   * type so the cloud-api Worker doesn't have to reach the container
   * bridge HTTP endpoint (which is unreachable for stopped/crashed
   * agents).
   */
  async fetchLogs(sandboxId: string, tail: number): Promise<string> {
    const meta = await this.resolveContainer(sandboxId);

    const safeTail = Math.max(1, Math.min(Math.floor(tail), 5000));

    const ssh = DockerSSHClient.getClient(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );
    // `2>&1` merges stderr so the user sees boot errors when an agent
    // is crash-looping — agents in node tend to write the interesting
    // failure traces to stderr.
    return await ssh.exec(
      `docker logs --tail ${safeTail} ${shellQuote(meta.containerName)} 2>&1`,
      DOCKER_CMD_TIMEOUT_MS,
    );
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Resolve a sandboxId to its container metadata.
   *
   * Lookup order:
   * 1. In-memory registry (fast path, avoids DB call)
   * 2. Database lookup (hydrates from persisted docker metadata)
   * 3. Last resort: env-var fallback with first node (for backwards compat)
   */
  private async resolveContainer(sandboxId: string): Promise<ContainerMeta> {
    // Fast path: already tracked in memory
    const tracked = this.containers.get(sandboxId);
    if (tracked) return tracked;

    const meta = await this.hydrateContainerFromDb(sandboxId);
    if (meta) return meta;

    throw new Error(
      `[docker-sandbox] Container "${sandboxId}" not found in memory or DB. Cannot resolve target node.`,
    );
  }

  /**
   * Resolve only the durable authority needed to stop a container. Failed
   * provisions can persist node and container identity before bridge/web ports
   * are assigned; requiring those unrelated runtime fields here made such a
   * container impossible to delete after a worker restart.
   */
  private async resolveContainerForTeardown(sandboxId: string): Promise<TeardownContainerMeta> {
    const tracked = this.containers.get(sandboxId);
    if (tracked) return tracked;

    // Destructive identity must use the same primary authority as the deletion
    // generation that immediately preceded it. A lagging or unavailable read
    // endpoint must not strand teardown after the primary accepted ownership.
    const sandbox = await agentSandboxesRepository.findBySandboxIdForWrite(sandboxId);
    if (!sandbox || !sandbox.node_id || !sandbox.container_name) {
      throw new Error(
        `[docker-sandbox] Container "${sandboxId}" not found in memory or DB. Cannot resolve target node.`,
      );
    }
    logger.info("[docker-sandbox] Teardown sandbox authority resolved", {
      agentId: sandbox.id,
    });

    const dbNode = await dockerNodesRepository.findByNodeIdOnPrimary(sandbox.node_id);
    if (!dbNode) {
      throw new Error(
        `[docker-sandbox] Missing persisted docker node metadata for node "${sandbox.node_id}"`,
      );
    }
    if (!dbNode.hostname) {
      throw new Error(`[docker-sandbox] Docker node "${sandbox.node_id}" is missing hostname`);
    }
    logger.info("[docker-sandbox] Teardown node authority resolved", {
      agentId: sandbox.id,
    });

    return {
      nodeId: sandbox.node_id,
      hostname: dbNode.hostname,
      containerName: sandbox.container_name,
      agentId: sandbox.id,
      sshPort: dbNode.ssh_port ?? DEFAULT_SSH_PORT,
      sshUser: dbNode.ssh_user ?? DEFAULT_SSH_USERNAME,
      hostKeyFingerprint: dbNode.host_key_fingerprint ?? undefined,
    };
  }

  /** Uses lifecycle-locked authority without reopening a competing DB lookup. */
  private async teardownMetaFromDeletionLocator(
    sandboxId: string,
    locator: SandboxDeletionLocator,
  ): Promise<TeardownContainerMeta> {
    if (
      locator.sandboxId !== sandboxId ||
      locator.containerName !== sandboxId ||
      locator.agentId.trim().length === 0 ||
      locator.nodeId.trim().length === 0
    ) {
      throw new Error("[docker-sandbox] Invalid lifecycle-captured deletion locator");
    }
    const hasCapturedSshAuthority =
      locator.hostname !== undefined ||
      locator.sshUser !== undefined ||
      locator.sshPort !== undefined ||
      locator.hostKeyFingerprint !== undefined;
    logger.info("[docker-sandbox] Teardown sandbox authority resolved", {
      agentId: locator.agentId,
    });
    const dbNode = hasCapturedSshAuthority
      ? null
      : await dockerNodesRepository.findByNodeIdOnPrimary(locator.nodeId);
    if (!hasCapturedSshAuthority && !dbNode) {
      throw new Error(
        `[docker-sandbox] Missing persisted docker node metadata for node "${locator.nodeId}"`,
      );
    }
    logger.info("[docker-sandbox] Teardown node authority resolved", {
      agentId: locator.agentId,
    });
    logger.info("[docker-sandbox] Teardown target resolved from lifecycle authority", {
      agentId: locator.agentId,
    });
    const hostname = hasCapturedSshAuthority ? locator.hostname : dbNode?.hostname;
    const sshUser = hasCapturedSshAuthority ? locator.sshUser : dbNode?.ssh_user;
    const sshPort = hasCapturedSshAuthority ? locator.sshPort : dbNode?.ssh_port;
    if (
      typeof hostname !== "string" ||
      !hostname.trim() ||
      typeof sshUser !== "string" ||
      !sshUser.trim() ||
      typeof sshPort !== "number" ||
      !Number.isSafeInteger(sshPort) ||
      sshPort < 1 ||
      sshPort > 65_535
    ) {
      throw new ElizaError("Deletion requires complete, valid SSH authority", {
        code: "SANDBOX_DELETION_SSH_AUTHORITY_INVALID",
        context: { agentId: locator.agentId, nodeId: locator.nodeId, hasCapturedSshAuthority },
      });
    }
    const tracked = this.containers.get(sandboxId);
    const trackedRegistration =
      tracked?.nodeId === locator.nodeId &&
      tracked.containerName === locator.containerName &&
      tracked.agentId === locator.agentId
        ? {
            tsHostname: tracked.tsHostname,
            vpnNodeId: tracked.vpnNodeId,
            previousVpnNodeId: tracked.previousVpnNodeId,
          }
        : {};
    return {
      nodeId: locator.nodeId,
      hostname: hostname.trim(),
      containerName: locator.containerName,
      agentId: locator.agentId,
      sshPort,
      sshUser: sshUser.trim(),
      hostKeyFingerprint: hasCapturedSshAuthority
        ? locator.hostKeyFingerprint
        : (dbNode?.host_key_fingerprint ?? undefined),
      ...trackedRegistration,
    };
  }

  /**
   * Read the container's node placement straight from the DB (agent_sandboxes
   * row + its docker_nodes record), bypassing the in-memory fast path, and
   * refresh the cache. Returns null only when there is no usable sandbox row;
   * repository and configuration failures propagate to the caller.
   */
  private async hydrateContainerFromDb(sandboxId: string): Promise<ContainerMeta | null> {
    const sandbox = await agentSandboxesRepository.findBySandboxId(sandboxId);
    if (!sandbox || !sandbox.node_id || !sandbox.container_name) return null;

    const dbNode = await dockerNodesRepository.findByNodeId(sandbox.node_id);
    if (!dbNode) {
      throw new Error(
        `[docker-sandbox] Missing persisted docker node metadata for node "${sandbox.node_id}"`,
      );
    }
    if (!dbNode.hostname) {
      throw new Error(`[docker-sandbox] Docker node "${sandbox.node_id}" is missing hostname`);
    }

    if (!sandbox.bridge_port || !sandbox.web_ui_port) {
      throw new Error(
        `[docker-sandbox] Missing port data for "${sandboxId}": bridge=${sandbox.bridge_port}, webUi=${sandbox.web_ui_port}`,
      );
    }

    const meta: ContainerMeta = {
      nodeId: sandbox.node_id,
      hostname: dbNode.hostname,
      containerName: sandbox.container_name,
      bridgePort: sandbox.bridge_port,
      webUiPort: sandbox.web_ui_port,
      agentId: sandbox.id, // sandbox.id IS the agent ID (PK = agent identifier throughout the system)
      sshPort: dbNode.ssh_port ?? DEFAULT_SSH_PORT,
      sshUser: dbNode.ssh_user ?? DEFAULT_SSH_USERNAME,
      hostKeyFingerprint: dbNode.host_key_fingerprint ?? undefined,
    };

    // Docker handles use the container name as sandboxId, so the refreshed row
    // updates the same cache key used by create, teardown, and runCommand.
    this.containers.set(sandboxId, meta);
    logger.info(
      `[docker-sandbox] Hydrated container "${sandboxId}" from DB -> node ${meta.nodeId} (${meta.hostname})`,
    );
    return meta;
  }

  /**
   * Re-read the container's current node from the DB during a long health poll.
   * A concurrent placement-affecting job (upgrade + resume + provision-retry can
   * overlap for one agent during a recovery storm) may re-place the agent onto a
   * different node mid-wait; the job that is polling health captured its node at
   * job start. Returning the last-known node on a refresh failure keeps a DB
   * blip from turning an otherwise-valid liveness probe into a failed provision.
   */
  private async refreshNodeMeta(previous: ContainerMeta): Promise<ContainerMeta> {
    let fresh: ContainerMeta | null;
    try {
      fresh = await this.hydrateContainerFromDb(previous.containerName);
    } catch (err) {
      // error-policy:J4 best-effort health-poll placement refresh - a failed
      // DB read cannot prove the previous node is wrong, so the liveness probe
      // keeps using the last-known placement and logs the refresh failure.
      logger.warn(
        `[docker-sandbox] Failed to refresh node for ${previous.containerName}; keeping ${previous.nodeId} (${previous.hostname}) for this health probe: ${err instanceof Error ? err.message : String(err)}`,
      );
      return previous;
    }

    if (!fresh) return previous;
    if (fresh.nodeId !== previous.nodeId || fresh.hostname !== previous.hostname) {
      logger.info(
        `[docker-sandbox] ${previous.containerName} re-placed mid health-wait: node ${previous.nodeId} (${previous.hostname}) -> ${fresh.nodeId} (${fresh.hostname}); following the new node`,
      );
    }
    return fresh;
  }
}
