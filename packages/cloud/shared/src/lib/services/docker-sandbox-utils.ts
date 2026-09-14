/**
 * Docker Sandbox Utilities
 *
 * Pure utility functions extracted from DockerSandboxProvider for reusability
 * and testability. These functions handle shell quoting, validation, port
 * allocation, and node configuration parsing.
 */

import { ElizaError } from "@elizaos/core";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DockerNodeEnv {
  nodeId: string;
  hostname: string;
  capacity: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BRIDGE_PORT_MIN = 18790;
export const BRIDGE_PORT_MAX = 19790;
export const WEBUI_PORT_MIN = 20000;
export const WEBUI_PORT_MAX = 25000;
export const DOCKER_CONTAINER_NAME_MAX_LENGTH = 128;
export const AGENT_CONTAINER_NAME_PREFIX = "agent-";
export const MAX_AGENT_ID_LENGTH =
  DOCKER_CONTAINER_NAME_MAX_LENGTH - AGENT_CONTAINER_NAME_PREFIX.length;

const CANONICAL_REPLACEMENT_PATH_ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPLACEMENT_ATTEMPT_CONTROL_ROOT = "/var/lib/eliza/replacement-attempts";
const REPLACEMENT_ARTIFACT_PURGE_RECEIPT = "ELIZA_REPLACEMENT_SECRET_PURGED_V1";
const REPLACEMENT_CANDIDATE_OBSERVED_RECEIPT = "ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1";
const REPLACEMENT_DOCKER_CREATE_QUIESCENT_RECEIPT = "ELIZA_REPLACEMENT_DOCKER_CREATE_QUIESCENT_V1";
const EXACT_RESTORE_STAGING_VOLUME_PURGE_RECEIPT = "ELIZA_EXACT_RESTORE_STAGING_VOLUME_PURGED_V1";
const REPLACEMENT_ATTEMPT_LOCK_TIMEOUT_SECONDS = 30;

export type DockerNodeArchitecture = "amd64" | "arm64";

// ---------------------------------------------------------------------------
// Container labels (test-vs-user marking + safe cleanup targeting)
// ---------------------------------------------------------------------------

/**
 * Every provisioner-created container carries these labels so fleet tooling
 * can distinguish REAL user agents from pool/test containers and from
 * unmanaged debris (hand-run containers, CI leftovers) without consulting the
 * DB. The disk-clean cycle's container prune excludes anything carrying
 * `CONTAINER_LABEL_MANAGED_BY` — a stopped user agent container must never be
 * reaped as a cleanup side effect (deleting it forces a full re-provision on
 * next start, the churn class behind #15228/#15398).
 */
export const CONTAINER_LABEL_MANAGED_BY = "ai.elizaos.managed-by";
export const CONTAINER_LABEL_MANAGED_BY_VALUE = "eliza-cloud";
export const CONTAINER_LABEL_AGENT_ID = "ai.elizaos.agent-id";
export const CONTAINER_LABEL_ORG_ID = "ai.elizaos.org-id";
export const CONTAINER_LABEL_CLASS = "ai.elizaos.container-class";

/**
 * user — a real user's agent; must never be deleted by cleanup tooling.
 * pool — a warm-pool entry owned by the sentinel pool org; reaped by the
 *        pool manager only.
 * test — created by a known test/QA org (containersEnv.testOrgIds()); CI and
 *        fleet janitors may reap these freely.
 */
export type AgentContainerClass = "user" | "pool" | "test";

export function resolveAgentContainerClass(
  organizationId: string,
  options: { warmPoolOrgId: string; testOrgIds: readonly string[] },
): AgentContainerClass {
  if (organizationId === options.warmPoolOrgId) return "pool";
  if (options.testOrgIds.includes(organizationId)) return "test";
  return "user";
}

/** Label key/value pairs shared by the remote and local docker providers. */
export function buildAgentContainerLabelArgs(options: {
  agentId: string;
  organizationId: string;
  containerClass: AgentContainerClass;
}): Array<[string, string]> {
  return [
    [CONTAINER_LABEL_MANAGED_BY, CONTAINER_LABEL_MANAGED_BY_VALUE],
    [CONTAINER_LABEL_AGENT_ID, options.agentId],
    [CONTAINER_LABEL_ORG_ID, options.organizationId],
    [CONTAINER_LABEL_CLASS, options.containerClass],
  ];
}

/**
 * `--label` flags for the remote `docker create` command string (pre-quoted).
 * The arg-array variant for local docker spawns is
 * `buildAgentContainerLabelArgs`.
 */
export function buildAgentContainerLabelFlags(options: {
  agentId: string;
  organizationId: string;
  containerClass: AgentContainerClass;
}): string[] {
  return buildAgentContainerLabelArgs(options).map(
    ([key, value]) => `--label ${shellQuote(`${key}=${value}`)}`,
  );
}

// ---------------------------------------------------------------------------
// Shell Quoting
// ---------------------------------------------------------------------------

/**
 * Shell-escape a single value by wrapping in single-quotes and escaping
 * embedded single-quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Idempotent, race-safe shell command that guarantees the shared agent bridge
 * network exists on a node before a container is attached to it.
 *
 * `node-bootstrap.ts` creates this network in cloud-init, but only for nodes
 * provisioned through the Hetzner Cloud autoscaler. Hetzner Robot cores (and
 * any node whose network was removed out-of-band) never run that bootstrap, so
 * `docker create --network <net>` fails with an opaque "network <net> not
 * found" and the provision retries forever. Running this first lets the
 * provisioner self-heal that drift.
 *
 * The final `inspect` covers the create-create race when two provisions land on
 * the same node simultaneously: the loser's `create` fails ("already exists"),
 * then the re-`inspect` confirms the winner's network and the command still
 * exits 0.
 */
export function buildEnsureNetworkCmd(network: string): string {
  const net = shellQuote(network);
  return [
    "set -eu",
    `if docker network inspect ${net} >/dev/null 2>&1; then exit 0; fi`,
    `if docker network create --driver bridge ${net} >/dev/null 2>&1; then exit 0; fi`,
    `if docker network inspect ${net} >/dev/null 2>&1; then exit 0; fi`,
    'if ! docker info >/dev/null 2>&1; then echo "[docker-network] daemon-unavailable" >&2; exit 70; fi',
    'echo "[docker-network] ensure-failed" >&2',
    "exit 71",
  ].join("; ");
}

// ---------------------------------------------------------------------------
// Platform / Architecture helpers
// ---------------------------------------------------------------------------

export function validateDockerPlatform(platform: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(platform)) {
    throw new Error(
      `Invalid Docker platform "${platform}": must contain only letters, numbers, dots, underscores, slashes, or hyphens.`,
    );
  }
}

export function normalizeDockerArchitecture(
  value: string | undefined | null,
): DockerNodeArchitecture | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["amd64", "x86", "x86_64", "x86-64", "x64"].includes(normalized)) return "amd64";
  if (["arm", "arm64", "aarch64", "arm64/v8"].includes(normalized)) return "arm64";
  return null;
}

export function requiredArchitectureForPlatform(
  platform: string | undefined | null,
): DockerNodeArchitecture | null {
  const normalized = platform?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("amd64") || normalized.includes("x86_64")) return "amd64";
  if (normalized.includes("arm64") || normalized.includes("aarch64")) return "arm64";
  return null;
}

export function inferArchitectureFromHetznerServerType(
  serverType: string | undefined | null,
): DockerNodeArchitecture | null {
  const normalized = serverType?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("cax")) return "arm64";
  if (normalized.startsWith("cx") || normalized.startsWith("cpx") || normalized.startsWith("ccx")) {
    return "amd64";
  }
  return null;
}

export function inferNodeArchitectureFromMetadata(
  metadata: unknown,
): DockerNodeArchitecture | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const explicit =
    typeof record.architecture === "string"
      ? normalizeDockerArchitecture(record.architecture)
      : null;
  if (explicit) return explicit;
  return typeof record.serverType === "string"
    ? inferArchitectureFromHetznerServerType(record.serverType)
    : null;
}

export function isArchitectureCompatibleWithPlatform(
  architecture: DockerNodeArchitecture | null,
  platform: string | undefined | null,
): boolean {
  const required = requiredArchitectureForPlatform(platform);
  return !required || !architecture || architecture === required;
}

export function dockerPlatformFlag(platform: string | undefined | null): string[] {
  const trimmed = platform?.trim();
  if (!trimmed) return [];
  validateDockerPlatform(trimmed);
  return [`--platform ${shellQuote(trimmed)}`];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function hasControlChars(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

/**
 * Validate an agent ID before using it in Docker-derived names and shell commands.
 * Must fit within Docker's 128-char container name limit after the `agent-`
 * prefix is applied.
 */
export function validateAgentId(agentId: string): void {
  if (
    agentId.length === 0 ||
    agentId.length > MAX_AGENT_ID_LENGTH ||
    hasControlChars(agentId) ||
    !/^[a-zA-Z0-9_-]+$/.test(agentId)
  ) {
    throw new Error(
      `Invalid agent ID "${agentId}": must be 1-${MAX_AGENT_ID_LENGTH} chars, alphanumeric / hyphens / underscores only.`,
    );
  }
}

/** Validate an agent name: printable characters, 1-64 chars, no shell metacharacters. */
export function validateAgentName(name: string): void {
  if (!name || name.length > 64) {
    throw new Error(`Invalid agent name: must be 1-64 characters.`);
  }
  // Block characters that could break shell commands even inside quotes
  if (hasControlChars(name)) {
    throw new Error(`Invalid agent name "${name}": contains control characters.`);
  }
}

/** Env keys must be shell-safe identifiers; allow lowercase for caller-supplied env vars. */
export function validateEnvKey(key: string): void {
  if (hasControlChars(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid environment variable key "${key}": must match ^[A-Za-z_][A-Za-z0-9_]*$.`,
    );
  }
}

/**
 * Env values are shell-safe once single-quoted, but we still reject control
 * characters so multi-line payloads and invisible bytes cannot reach the remote
 * shell command. Callers should pass a key so production errors are debuggable.
 */
export function validateEnvValue(key: string, value: string): void {
  if (hasControlChars(value)) {
    throw new Error(
      `Invalid environment variable value for key "${key}": contains control characters (newlines and PEM-encoded values are not supported).`,
    );
  }
}

const PUBLIC_CONTAINER_ENV_KEY_ALLOWLIST = new Set([
  "AGENT_DISABLE_AUTO_API_TOKEN",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
]);

/**
 * Keep only fixed, non-secret feature flags on the Docker command line.
 * Caller-provided environment keys are arbitrary BYO-secret material, so an
 * unknown name must fail closed to the stdin-backed env file rather than rely
 * on a credential-name heuristic.
 */
export function isSecretContainerEnvKey(key: string): boolean {
  return !PUBLIC_CONTAINER_ENV_KEY_ALLOWLIST.has(key);
}

export interface DockerContainerEnvTransport {
  commandFlags: string[];
  secretInput: string;
}

export interface DockerEnvFileStdinTransport {
  /** Shell command whose environment-related argv contains only the temporary env-file path. */
  command: string;
  /** Versioned, bounded frame that must be delivered through an stdin-capable executor. */
  input: string;
}

export interface DockerEnvFileStdinTransportOptions {
  /** Override for isolated tests; production callers use restrictive files under `/tmp`. */
  temporaryDirectory?: string;
}

const CONTAINER_SECRET_ENV_STDIN_SENTINEL = "ELIZA_SECRET_ENV_STDIN_V1_END";
const DOCKER_ENV_FILE_STDIN_VERSION = "ELIZA_DOCKER_ENV_FILE_STDIN_V1";
const DOCKER_ENV_FILE_STDIN_END = "ELIZA_DOCKER_ENV_FILE_STDIN_V1_END";
const DOCKER_ENV_FILE_STDIN_LENGTH_DIGITS = 6;
const DOCKER_ENV_FILE_STDIN_HEADER_BYTES = Buffer.byteLength(
  `${DOCKER_ENV_FILE_STDIN_VERSION} ${"0".repeat(DOCKER_ENV_FILE_STDIN_LENGTH_DIGITS)}\n`,
);
const DOCKER_ENV_FILE_STDIN_END_BYTES = Buffer.byteLength(`${DOCKER_ENV_FILE_STDIN_END}\n`);
const MAX_DOCKER_ENV_TRANSPORT_BYTES = 256 * 1024;
const MAX_DOCKER_PROCESS_ENV_ENTRY_BYTES = 120 * 1024;
const MAX_DOCKER_ENV_FILE_LINE_BYTES = 60 * 1024;
const RESERVED_DOCKER_ENV_TRANSPORT_KEYS = new Set(["env_file", "env_frame_file", "env_end_file"]);
const DOCKER_CLIENT_CONTROL_ENV_KEYS = new Set([
  "ALL_PROXY",
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "EUID",
  "GLOBIGNORE",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "IFS",
  "LANG",
  "LINENO",
  "LOGNAME",
  "NO_PROXY",
  "OLDPWD",
  "OPTARG",
  "OPTIND",
  "PATH",
  "POSIXLY_CORRECT",
  "PPID",
  "PROMPT_COMMAND",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PWD",
  "RANDOM",
  "SECONDS",
  "SHELL",
  "SHELLOPTS",
  "SHLVL",
  "SSH_AUTH_SOCK",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "UID",
  "USER",
  "_",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function isDockerClientControlEnvKey(key: string): boolean {
  if (
    /^(?:DOCKER_|LD_|DYLD_|XDG_|LC_|MALLOC_)/.test(key) ||
    /^(?:GODEBUG|GOMAXPROCS|GOMEMLIMIT|GOTRACEBACK)$/.test(key)
  ) {
    return true;
  }
  return DOCKER_CLIENT_CONTROL_ENV_KEYS.has(key);
}

interface DockerEnvironmentPartition {
  processEnvironment: Record<string, string>;
  envFileBody: string;
}

/**
 * Partition an arbitrary container environment without allowing it to steer
 * the shell wrapper or Docker client. Ordinary values are exported only so a
 * key-only env-file entry can copy them into the container. Docker/shell
 * control variables remain explicit env-file records and never reach the
 * provisioning process environment.
 */
function partitionDockerEnvironment(
  environment: Readonly<Record<string, string>>,
): DockerEnvironmentPartition {
  // A valid POSIX env key may be `__proto__`; a null-prototype record keeps it
  // as data instead of invoking Object.prototype's legacy setter.
  const processEnvironment = Object.create(null) as Record<string, string>;
  const envFileLines: string[] = [];
  let rawBytes = 0;

  for (const [key, value] of Object.entries(environment)) {
    validateEnvKey(key);
    if (RESERVED_DOCKER_ENV_TRANSPORT_KEYS.has(key)) {
      throw new Error(`Environment variable "${key}" is reserved by the Docker stdin transport.`);
    }
    if (value.includes("\0")) {
      throw new Error(`Invalid environment variable value for key "${key}": contains NUL.`);
    }

    const entryBytes = Buffer.byteLength(`${key}=${value}`);
    if (entryBytes > MAX_DOCKER_PROCESS_ENV_ENTRY_BYTES) {
      throw new Error(
        `Environment variable "${key}" exceeds the ${MAX_DOCKER_PROCESS_ENV_ENTRY_BYTES}-byte process entry limit.`,
      );
    }
    rawBytes += entryBytes + 1;
    if (rawBytes > MAX_DOCKER_ENV_TRANSPORT_BYTES) {
      throw new Error(
        `Container environment exceeds the ${MAX_DOCKER_ENV_TRANSPORT_BYTES}-byte transport limit.`,
      );
    }

    if (isDockerClientControlEnvKey(key)) {
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error(
          `Docker client control variable "${key}" must be single-line so it cannot alter the provisioning client.`,
        );
      }
      if (entryBytes > MAX_DOCKER_ENV_FILE_LINE_BYTES) {
        throw new Error(
          `Docker client control variable "${key}" exceeds the ${MAX_DOCKER_ENV_FILE_LINE_BYTES}-byte env-file line limit.`,
        );
      }
      envFileLines.push(`${key}=${value}`);
      continue;
    }

    processEnvironment[key] = value;
    envFileLines.push(key);
  }

  return {
    processEnvironment,
    envFileBody: envFileLines.length > 0 ? `${envFileLines.join("\n")}\n` : "",
  };
}

function buildDockerEnvironmentFrame(environment: Readonly<Record<string, string>>): string {
  const partition = partitionDockerEnvironment(environment);
  const exportLines = Object.entries(partition.processEnvironment).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`,
  );
  const envScript = [
    ...exportLines,
    `printf '%s' ${shellQuote(partition.envFileBody)} > "$env_file"`,
  ].join("\n");
  const framedScript = `${envScript}\n`;
  const framedScriptBytes = Buffer.byteLength(framedScript);
  if (framedScriptBytes > MAX_DOCKER_ENV_TRANSPORT_BYTES) {
    throw new Error(
      `Container environment frame exceeds the ${MAX_DOCKER_ENV_TRANSPORT_BYTES}-byte transport limit.`,
    );
  }
  const encodedLength = String(framedScriptBytes).padStart(
    DOCKER_ENV_FILE_STDIN_LENGTH_DIGITS,
    "0",
  );
  return `${DOCKER_ENV_FILE_STDIN_VERSION} ${encodedLength}\n${framedScript}${DOCKER_ENV_FILE_STDIN_END}\n`;
}

/** Validate the exact bounded stdin frame before callers mutate container state. */
export function validateDockerEnvFileStdinEnvironment(
  environment: Readonly<Record<string, string>>,
): void {
  buildDockerEnvironmentFrame(environment);
}

/**
 * Build a one-shot, stdin-only Docker environment transport. The remote shell
 * accepts exactly one bounded frame, creates restrictive temporary files,
 * verifies the terminal sentinel and EOF, and removes every file on success,
 * failure, timeout-driven HUP, or another handled signal.
 */
export function buildDockerEnvFileStdinTransport(
  environment: Readonly<Record<string, string>>,
  buildDockerCommand: (envFilePath: string) => string,
  options: DockerEnvFileStdinTransportOptions = {},
): DockerEnvFileStdinTransport {
  const input = buildDockerEnvironmentFrame(environment);
  const temporaryDirectory = options.temporaryDirectory ?? "/tmp";
  validateVolumePath(temporaryDirectory);

  const envFrameTemplate = shellQuote(`${temporaryDirectory}/eliza-docker-env-frame.XXXXXX`);
  const envFileTemplate = shellQuote(`${temporaryDirectory}/eliza-docker-env.XXXXXX`);
  const envEndFileTemplate = shellQuote(`${temporaryDirectory}/eliza-docker-env-end.XXXXXX`);
  const dockerCommand = buildDockerCommand('"$env_file"');
  if (!dockerCommand.trim()) {
    throw new Error("Docker env-file stdin transport requires a non-empty command.");
  }

  return {
    input,
    command: [
      "set -eu",
      "env_frame_file=",
      "env_file=",
      "env_end_file=",
      'cleanup_env_files() { test -z "$env_frame_file" || rm -f "$env_frame_file"; test -z "$env_end_file" || rm -f "$env_end_file"; test -z "$env_file" || rm -f "$env_file"; }',
      "trap cleanup_env_files EXIT",
      "trap 'exit 1' HUP INT TERM",
      "umask 077",
      `env_frame_file=$(mktemp ${envFrameTemplate})`,
      `env_file=$(mktemp ${envFileTemplate})`,
      `env_end_file=$(mktemp ${envEndFileTemplate})`,
      'chmod 600 "$env_frame_file" "$env_end_file" "$env_file"',
      `dd bs=1 count=${DOCKER_ENV_FILE_STDIN_HEADER_BYTES} of="$env_frame_file" status=none`,
      `test "$(wc -c < "$env_frame_file" | tr -d ' ')" = ${DOCKER_ENV_FILE_STDIN_HEADER_BYTES}`,
      'env_header=$(cat "$env_frame_file")',
      `case "$env_header" in ${shellQuote(`${DOCKER_ENV_FILE_STDIN_VERSION} `)}??????) ;; *) exit 44 ;; esac`,
      `env_length_padded=\${env_header#${DOCKER_ENV_FILE_STDIN_VERSION} }`,
      "case \"$env_length_padded\" in ''|*[!0-9]*) exit 44 ;; esac",
      "env_length=$(printf %s \"$env_length_padded\" | sed 's/^0*//')",
      'test -n "$env_length" || env_length=0',
      `test "$env_length" -le ${MAX_DOCKER_ENV_TRANSPORT_BYTES}`,
      'if test "$env_length" -gt 0; then dd bs=1 count="$env_length" of="$env_frame_file" status=none; else : > "$env_frame_file"; fi',
      "env_actual_length=$(wc -c < \"$env_frame_file\" | tr -d ' ')",
      'test "$env_actual_length" = "$env_length"',
      `dd bs=1 count=${DOCKER_ENV_FILE_STDIN_END_BYTES} of="$env_end_file" status=none`,
      `test "$(wc -c < "$env_end_file" | tr -d ' ')" = ${DOCKER_ENV_FILE_STDIN_END_BYTES}`,
      `test "$(cat "$env_end_file")" = ${shellQuote(DOCKER_ENV_FILE_STDIN_END)}`,
      "test \"$(dd bs=1 count=1 status=none | wc -c | tr -d ' ')\" = 0",
      '. "$env_frame_file"',
      'chmod 600 "$env_file"',
      dockerCommand,
    ].join("; "),
  };
}

/** Split validated container env into visible flags and stdin-only entries. */
export function buildDockerContainerEnvTransport(
  environment: Readonly<Record<string, string>>,
): DockerContainerEnvTransport {
  const commandFlags: string[] = [];
  const secretLines: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    validateEnvKey(key);
    validateEnvValue(key, value);
    if (isSecretContainerEnvKey(key)) {
      secretLines.push(`${key}=${value}`);
    } else {
      commandFlags.push(`-e ${shellQuote(`${key}=${value}`)}`);
    }
  }
  return {
    commandFlags,
    secretInput: `${secretLines.length > 0 ? `${secretLines.join("\n")}\n` : ""}ELIZA_VAULT_PASSPHRASE=\n${CONTAINER_SECRET_ENV_STDIN_SENTINEL}\n`,
  };
}

/** Docker container names must be simple shell-safe identifiers. */
export function validateContainerName(containerName: string): void {
  if (hasControlChars(containerName) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) {
    throw new Error(
      `Invalid container name "${containerName}": must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$.`,
    );
  }
}

/** Docker host volume paths must be absolute, normalized, and shell-safe. */
export function validateVolumePath(volumePath: string): void {
  // First allow only absolute shell-safe path characters, reject the root path,
  // then separately enforce normalized-form rules like no traversal, repeated
  // separators, or trailing slash.
  if (
    hasControlChars(volumePath) ||
    volumePath === "/" ||
    !/^\/[A-Za-z0-9._/-]+$/.test(volumePath)
  ) {
    throw new Error(`Invalid volume path "${volumePath}".`);
  }
  if (
    volumePath.includes("//") ||
    volumePath.includes("/./") ||
    volumePath.includes("/../") ||
    volumePath.endsWith("/.") ||
    volumePath.endsWith("/..") ||
    (volumePath.length > 1 && volumePath.endsWith("/"))
  ) {
    throw new Error(`Invalid volume path "${volumePath}": path must be normalized.`);
  }
}

// ---------------------------------------------------------------------------
// Steward / Docker host routing
// ---------------------------------------------------------------------------

/**
 * Resolve the URL injected into containers for talking back to Steward.
 *
 * - Explicit STEWARD_CONTAINER_URL wins.
 * - Otherwise, when the host-side Steward URL points at localhost/loopback,
 *   rewrite it to host.docker.internal for container reachability.
 * - Non-loopback host URLs pass through unchanged.
 */
export function resolveStewardContainerUrl(
  stewardHostUrl: string = process.env.STEWARD_API_URL || "http://localhost:8787/steward",
  stewardContainerUrl?: string,
): string {
  const override = stewardContainerUrl?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }

  let url: URL;
  try {
    url = new URL(stewardHostUrl);
  } catch {
    throw new Error(`[docker-sandbox] Invalid STEWARD_API_URL: ${JSON.stringify(stewardHostUrl)}`);
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

/** Linux Docker needs an explicit host-gateway alias for host.docker.internal. */
export function requiresDockerHostGateway(targetUrl: string): boolean {
  try {
    return new URL(targetUrl).hostname === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Docker prints the created container ID on the final stdout line.
 * Validate that line so warnings or unexpected output do not get mistaken
 * for a container ID.
 */
export function extractDockerCreateContainerId(
  output: string,
  options: { requireFullId?: boolean } = {},
): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let containerId: string | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (/^[0-9a-f]{12,64}$/i.test(line)) {
      containerId = line;
      break;
    }
  }

  if (!containerId) {
    const lastLine = lines.at(-1);
    throw new Error(
      `[docker-sandbox] docker create returned an invalid container id: ${JSON.stringify(lastLine ?? "")}`,
    );
  }

  if (options.requireFullId) {
    if (!/^[0-9a-f]{64}$/.test(containerId)) {
      throw new Error("[docker-sandbox] paid compute requires the full immutable Docker id");
    }
    return containerId;
  }
  return containerId.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Port Allocation
// ---------------------------------------------------------------------------

/**
 * Pick a random port in [min, max) that is not in the exclusion set.
 * TOCTOU safety: the DB has a partial UNIQUE index on (node_id, bridge_port)
 * for active sandboxes, so a duplicate insert will fail and the caller
 * should retry the entire provisioning flow.
 */
export function allocatePort(min: number, max: number, excluded: Set<number>): number {
  const range = max - min;
  if (excluded.size >= range) {
    throw new Error(
      `[docker-sandbox] No available ports in range [${min}, ${max}). All ${range} ports are allocated.`,
    );
  }
  let port: number;
  let attempts = 0;
  do {
    port = min + Math.floor(Math.random() * range);
    attempts++;
    if (attempts > range * 2) {
      throw new Error(
        `[docker-sandbox] Failed to find an available port in range [${min}, ${max}) after ${attempts} attempts.`,
      );
    }
  } while (excluded.has(port));
  return port;
}

export function readDockerHostPortFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const hostPort = (metadata as Record<string, unknown>).hostPort;
  if (typeof hostPort !== "number") return null;
  return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null;
}

// ---------------------------------------------------------------------------
// Container Naming & Paths
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic container name from an agent ID.
 * Uses the full agentId to avoid collisions (truncated UUIDs share prefix
 * patterns and can collide on the same node).
 */
export function getContainerName(agentId: string): string {
  validateAgentId(agentId);
  const containerName = `${AGENT_CONTAINER_NAME_PREFIX}${agentId}`;
  // Keep this derived-output validation as a guardrail if the naming template changes.
  validateContainerName(containerName);
  return containerName;
}

/** Volume path on the Docker host for persistent agent data. */
export function getVolumePath(agentId: string): string {
  validateAgentId(agentId);
  const volumePath = `/data/agents/${agentId}`;
  validateVolumePath(volumePath);
  return volumePath;
}

function assertCanonicalReplacementPathAttemptId(replacementAttemptId: string): void {
  if (!CANONICAL_REPLACEMENT_PATH_ATTEMPT_ID.test(replacementAttemptId)) {
    throw new ElizaError("Invalid replacement attempt ID for remote attempt artifacts.", {
      code: "SANDBOX_REPLACEMENT_REMOTE_ATTEMPT_ID_INVALID",
      context: { replacementAttemptId },
      severity: "fatal",
    });
  }
}

function getReplacementAttemptControlDirectory(replacementAttemptId: string): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  return `${REPLACEMENT_ATTEMPT_CONTROL_ROOT}/${replacementAttemptId}`;
}

/**
 * Root-only host path used for one exact replacement's transient Docker env.
 *
 * The agent volume is intentionally not used: a prior runtime can write that
 * mount and could retain secret bytes through a symlink or hardlink even after
 * the provisioner's nominal cleanup succeeds.
 */
export function getReplacementControlSecretEnvPath(replacementAttemptId: string): string {
  return `${getReplacementAttemptControlDirectory(replacementAttemptId)}/container-env`;
}

/** Root-only snapshot consumed by one exact replacement's Docker create. */
export function getReplacementControlVaultPassphrasePath(replacementAttemptId: string): string {
  return `${getReplacementAttemptControlDirectory(replacementAttemptId)}/vault-passphrase`;
}

function getReplacementControlVaultArtifactPath(
  replacementAttemptId: string,
  kind: "stdin" | "override" | "generated" | "normalized",
): string {
  return `${getReplacementAttemptControlDirectory(replacementAttemptId)}/vault-${kind}`;
}

function secureFileShellPrelude(expectedUid: "0" | "$(id -u)"): string[] {
  return [
    "command -v stat >/dev/null 2>&1",
    ...(expectedUid === "$(id -u)" ? ["command -v id >/dev/null 2>&1"] : []),
    `secure_expected_uid=${expectedUid}`,
    "secure_stat_uid() { stat -c '%u' -- \"$1\" 2>/dev/null || stat -f '%u' \"$1\"; }",
    "secure_stat_links() { stat -c '%h' -- \"$1\" 2>/dev/null || stat -f '%l' \"$1\"; }",
    "secure_stat_mode() { stat -c '%a' -- \"$1\" 2>/dev/null || stat -f '%Lp' \"$1\"; }",
    "secure_stat_identity() { stat -c '%d:%i' -- \"$1\" 2>/dev/null || stat -f '%d:%i' \"$1\"; }",
    // Exact secret transport runs only on GNU/Linux Docker nodes. BSD stat on
    // /dev/fd reports fdescfs metadata rather than the opened inode, so the
    // FD-bound proof must fail closed instead of advertising a false fallback.
    "secure_fd_stat_uid() { stat -Lc '%u' -- \"/dev/fd/$1\"; }",
    "secure_fd_stat_links() { stat -Lc '%h' -- \"/dev/fd/$1\"; }",
    "secure_fd_stat_mode() { stat -Lc '%a' -- \"/dev/fd/$1\"; }",
    "secure_fd_stat_identity() { stat -Lc '%d:%i' -- \"/dev/fd/$1\"; }",
    "secure_fd_stat_fingerprint() { stat -Lc '%d:%i:%s:%y:%z' -- \"/dev/fd/$1\"; }",
    'secure_regular_file_proof() { secure_path=$1; secure_code=${2:-70}; test -f "$secure_path" && test ! -L "$secure_path" || exit "$secure_code"; test "$(secure_stat_uid "$secure_path")" = "$secure_expected_uid" || exit "$secure_code"; test "$(secure_stat_links "$secure_path")" = 1 || exit "$secure_code"; }',
    'secure_private_regular_file_proof() { secure_path=$1; secure_code=${2:-70}; secure_regular_file_proof "$secure_path" "$secure_code"; test "$(secure_stat_mode "$secure_path")" = 600 || exit "$secure_code"; }',
    'secure_private_regular_fd_proof() { secure_fd=$1; secure_code=${2:-70}; test -f "/dev/fd/$secure_fd" || exit "$secure_code"; test "$(secure_fd_stat_uid "$secure_fd")" = "$secure_expected_uid" || exit "$secure_code"; test "$(secure_fd_stat_links "$secure_fd")" = 1 || exit "$secure_code"; test "$(secure_fd_stat_mode "$secure_fd")" = 600 || exit "$secure_code"; }',
    'secure_reset_file() { secure_path=$1; if ! rm -f -- "$secure_path"; then exit 70; fi; if ! (set -C; : > "$secure_path") 2>/dev/null; then exit 70; fi; secure_regular_file_proof "$secure_path"; chmod 600 "$secure_path"; secure_private_regular_file_proof "$secure_path"; }',
  ];
}

function getReplacementVolumePath(containerName: string): string {
  validateContainerName(containerName);
  if (!containerName.startsWith(AGENT_CONTAINER_NAME_PREFIX)) {
    throw new ElizaError("Replacement container name does not identify an agent volume.", {
      code: "SANDBOX_REPLACEMENT_CONTAINER_NAME_NOT_AGENT",
      context: { containerName },
      severity: "fatal",
    });
  }
  const agentId = containerName.slice(AGENT_CONTAINER_NAME_PREFIX.length);
  validateAgentId(agentId);
  if (getContainerName(agentId) !== containerName) {
    throw new ElizaError("Replacement container name is not canonical.", {
      code: "SANDBOX_REPLACEMENT_CONTAINER_NAME_NONCANONICAL",
      context: { containerName },
      severity: "fatal",
    });
  }
  return getVolumePath(agentId);
}

function replacementAttemptControlPrelude(replacementAttemptId: string): string[] {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  const attemptDirectory = getReplacementAttemptControlDirectory(replacementAttemptId);
  return [
    "command -v flock >/dev/null 2>&1",
    ...secureFileShellPrelude("0"),
    `attempt_root=${shellQuote(REPLACEMENT_ATTEMPT_CONTROL_ROOT)}`,
    `attempt_dir=${shellQuote(attemptDirectory)}`,
    'attempt_lock="$attempt_dir/lock"',
    'attempt_cancelled="$attempt_dir/cancelled"',
    'attempt_active="$attempt_dir/active"',
    'attempt_candidate_id="$attempt_dir/candidate-id"',
    'attempt_docker_error="$attempt_dir/docker-error"',
    'secure_parent_directory_proof() { secure_path=$1; test -d "$secure_path" && test ! -L "$secure_path" || exit 70; test "$(secure_stat_uid "$secure_path")" = 0 || exit 70; secure_mode=$(secure_stat_mode "$secure_path"); case "$secure_mode" in *[2367][0-7]|*[0-7][2367]) exit 70 ;; esac; }',
    'secure_private_directory_proof() { secure_parent_directory_proof "$1"; test "$(secure_stat_mode "$1")" = 700 || exit 70; }',
    'secure_prepare_control_parent() { secure_path=$1; if test -e "$secure_path" || test -L "$secure_path"; then secure_parent_directory_proof "$secure_path"; else mkdir -p -- "$secure_path"; secure_parent_directory_proof "$secure_path"; fi; }',
    'secure_prepare_private_directory() { secure_path=$1; if test -e "$secure_path" || test -L "$secure_path"; then secure_parent_directory_proof "$secure_path"; else mkdir -p -- "$secure_path"; secure_parent_directory_proof "$secure_path"; fi; chmod 700 -- "$secure_path"; secure_private_directory_proof "$secure_path"; }',
    'secure_existing_control_file() { secure_path=$1; if test -e "$secure_path" || test -L "$secure_path"; then secure_regular_file_proof "$secure_path"; else if ! (set -C; : > "$secure_path") 2>/dev/null; then secure_regular_file_proof "$secure_path"; fi; fi; secure_regular_file_proof "$secure_path"; chmod 600 -- "$secure_path"; secure_private_regular_file_proof "$secure_path"; }',
    'secure_reset_control_file() { secure_reset_file "$1"; }',
    "control_parent=${attempt_root%/*}",
    'secure_prepare_control_parent "$control_parent"',
    'secure_prepare_private_directory "$attempt_root"',
    'secure_prepare_private_directory "$attempt_dir"',
    'secure_existing_control_file "$attempt_lock"',
    'exec 9>>"$attempt_lock"',
    `flock -w ${REPLACEMENT_ATTEMPT_LOCK_TIMEOUT_SECONDS} 9`,
  ];
}

/** Exact non-secret receipt expected after fenced remote artifact cleanup. */
export function getReplacementSecretArtifactsCleanupReceipt(replacementAttemptId: string): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  return `${REPLACEMENT_ARTIFACT_PURGE_RECEIPT} ${replacementAttemptId}`;
}

function assertCanonicalDockerContainerId(containerId: string): void {
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
    throw new ElizaError("Invalid Docker container ID for replacement candidate proof.", {
      code: "SANDBOX_REPLACEMENT_DOCKER_CONTAINER_ID_INVALID",
      context: { containerId },
      severity: "fatal",
    });
  }
}

/** Exact non-secret receipt for the durable candidate ID observed by cleanup. */
export function getReplacementCandidateObservedReceipt(
  replacementAttemptId: string,
  containerId: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  assertCanonicalDockerContainerId(containerId);
  return `${REPLACEMENT_CANDIDATE_OBSERVED_RECEIPT} ${replacementAttemptId} ${containerId}`;
}

/** Exact non-secret receipt proving no Docker-create shell remains ambiguous. */
export function getReplacementDockerCreateQuiescentReceipt(replacementAttemptId: string): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  return `${REPLACEMENT_DOCKER_CREATE_QUIESCENT_RECEIPT} ${replacementAttemptId}`;
}

/** Exact non-secret receipt proving one abandoned restore staging path is absent. */
export function getExactRestoreStagingVolumeCleanupReceipt(
  replacementAttemptId: string,
  restoreAttemptId: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  assertCanonicalReplacementPathAttemptId(restoreAttemptId);
  return `${EXACT_RESTORE_STAGING_VOLUME_PURGE_RECEIPT} ${replacementAttemptId} ${restoreAttemptId}`;
}

// ---------------------------------------------------------------------------
// Durable per-agent vault state (#18080 / #19225)
// ---------------------------------------------------------------------------

/**
 * In-container state root injected as `ELIZA_STATE_DIR` on every provisioned
 * container. `/root/.eliza` is the `${volumePath}/eliza` bind mount, so the
 * state-dir vault (`.vault-pglite`), config, and media survive container
 * replacement/reschedule; without it the runtime resolves state to
 * `/root/.local/state/eliza` in the container's writable layer and every
 * replacement silently drops stored connector credentials.
 */
export const CONTAINER_DURABLE_STATE_DIR = "/root/.eliza";

/** Stable public labels for byte-native producers of the vault stdin frame. */
export const VOLUME_VAULT_STDIN_FRAME_VERSION = "ELIZA_VAULT_STDIN_V1";
export const VOLUME_VAULT_STDIN_FRAME_END = "ELIZA_VAULT_STDIN_V1_END";

/** Host-side path of the persisted per-agent vault master passphrase. */
export function getVolumeVaultPassphrasePath(volumePath: string): string {
  return `${volumePath}/.vault-passphrase`;
}

function getVolumeVaultPassphrasePublicationCandidatePath(
  volumePath: string,
  replacementAttemptId: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  return `${getVolumeVaultPassphrasePath(volumePath)}.candidate.${replacementAttemptId}`;
}

/**
 * Shell command that establishes and validates the per-agent vault master
 * passphrase persisted on the host volume. A versioned frame containing an
 * optional operator seed arrives only on stdin; the command emits no
 * passphrase bytes. Replacement containers therefore derive the same
 * per-volume key without exposing it to the caller.
 */
export function buildVolumeVaultPassphraseCommand(
  volumePath: string,
  overrideByteLength = 0,
  replacementAttemptId?: string,
  fencedPreparationCommands: readonly string[] = [],
): string {
  if (!Number.isSafeInteger(overrideByteLength) || overrideByteLength < 0) {
    throw new Error("Vault passphrase override byte length must be a non-negative integer.");
  }
  const keyPath = getVolumeVaultPassphrasePath(volumePath);
  if (replacementAttemptId !== undefined) {
    assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  }
  if (fencedPreparationCommands.length > 0 && replacementAttemptId === undefined) {
    throw new Error("Vault preparation commands require a fenced replacement attempt.");
  }
  const keyFile = shellQuote(keyPath);
  const transientPath = (kind: "stdin" | "override" | "generated" | "normalized"): string =>
    replacementAttemptId
      ? shellQuote(getReplacementControlVaultArtifactPath(replacementAttemptId, kind))
      : `${shellQuote(`${keyPath}.${kind}`)}.$$`;
  const stdinFile = transientPath("stdin");
  const overrideFile = transientPath("override");
  const generatedFile = transientPath("generated");
  const normalizedFile = transientPath("normalized");
  const vaultSnapshotFile = replacementAttemptId
    ? shellQuote(getReplacementControlVaultPassphrasePath(replacementAttemptId))
    : undefined;
  // The publication candidate must share the durable key's filesystem: `ln`
  // is the atomic first-writer primitive and cannot cross a mount boundary.
  // Other plaintext temporaries remain in the root-only control directory.
  const keyCandidateFile = replacementAttemptId
    ? shellQuote(getVolumeVaultPassphrasePublicationCandidatePath(volumePath, replacementAttemptId))
    : undefined;
  const cleanupTargets = [
    '"$stdin_file"',
    '"$override_file"',
    '"$generated_file"',
    '"$normalized_file"',
    ...(keyCandidateFile ? ['"$key_candidate_file"'] : []),
  ].join(" ");
  const cleanupAbsenceProof = [
    'test -e "$stdin_file"',
    'test -L "$stdin_file"',
    'test -e "$override_file"',
    'test -L "$override_file"',
    'test -e "$generated_file"',
    'test -L "$generated_file"',
    'test -e "$normalized_file"',
    'test -L "$normalized_file"',
    ...(keyCandidateFile ? ['test -e "$key_candidate_file"', 'test -L "$key_candidate_file"'] : []),
  ].join(" || ");
  const cleanupFunction =
    `cleanup_vault_temp_files() { cleanup_status=$?; if ! rm -f -- ${cleanupTargets}; then if test "$cleanup_status" -eq 0; then cleanup_status=70; fi; fi; ` +
    `if ${cleanupAbsenceProof}; then if test "$cleanup_status" -eq 0; then cleanup_status=70; fi; fi; ` +
    (vaultSnapshotFile
      ? 'if test "$cleanup_status" -ne 0 || test "$vault_snapshot_ready" -ne 1; then if ! rm -f -- "$vault_snapshot_file"; then if test "$cleanup_status" -eq 0; then cleanup_status=70; fi; fi; if test -e "$vault_snapshot_file" || test -L "$vault_snapshot_file"; then if test "$cleanup_status" -eq 0; then cleanup_status=70; fi; fi; fi; '
      : "") +
    'trap - EXIT; exit "$cleanup_status"; }';
  const expectedHeader = `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${overrideByteLength}`;
  const expectedFrameByteLength =
    Buffer.byteLength(expectedHeader) +
    1 +
    overrideByteLength +
    1 +
    Buffer.byteLength(VOLUME_VAULT_STDIN_FRAME_END) +
    1;
  const createFencedDurableKeyCommand = [
    'if test -e "$key_file" || test -L "$key_file"; then',
    'secure_private_regular_file_proof "$key_file";',
    "else",
    // Generate under the root-only control tree first, then copy through
    // verified descriptors into an exclusively-created candidate beside the
    // durable key. Only that final candidate crosses into the agent volume.
    'secure_reset_file "$generated_file";',
    'exec 8>>"$generated_file";',
    'if test -s "$override_file"; then secure_private_regular_file_proof "$override_file"; exec 7<"$override_file"; secure_private_regular_fd_proof 7; cat <&7 >&8; exec 7<&-; else head -c 32 /dev/urandom | od -An -tx1 | tr -d \' \\n\' >&8; fi;',
    "exec 8>&-;",
    'secure_private_regular_file_proof "$generated_file";',
    'if ! rm -f -- "$key_candidate_file"; then exit 70; fi;',
    "set -C;",
    'if exec 8>"$key_candidate_file"; then set +C; else set +C; exit 70; fi;',
    "secure_private_regular_fd_proof 8;",
    "key_candidate_fd_identity=$(secure_fd_stat_identity 8);",
    'secure_private_regular_file_proof "$key_candidate_file";',
    'test "$(secure_stat_identity "$key_candidate_file")" = "$key_candidate_fd_identity" || exit 70;',
    'exec 7<"$generated_file";',
    "secure_private_regular_fd_proof 7;",
    "generated_fd_identity=$(secure_fd_stat_identity 7);",
    "generated_fd_fingerprint_before=$(secure_fd_stat_fingerprint 7);",
    'test "$(secure_stat_identity "$generated_file")" = "$generated_fd_identity" || exit 70;',
    "cat <&7 >&8;",
    "generated_fd_fingerprint_after=$(secure_fd_stat_fingerprint 7);",
    'test "$generated_fd_fingerprint_before" = "$generated_fd_fingerprint_after" || exit 70;',
    "exec 7<&-;",
    "secure_private_regular_fd_proof 8;",
    'test "$(secure_fd_stat_identity 8)" = "$key_candidate_fd_identity" || exit 70;',
    'secure_private_regular_file_proof "$key_candidate_file";',
    'test "$(secure_stat_identity "$key_candidate_file")" = "$key_candidate_fd_identity" || exit 70;',
    "exec 8>&-;",
    'secure_private_regular_file_proof "$key_candidate_file";',
    'test "$(secure_stat_identity "$key_candidate_file")" = "$key_candidate_fd_identity" || exit 70;',
    "created_key_identity=$key_candidate_fd_identity;",
    'if ln "$key_candidate_file" "$key_file" 2>/dev/null; then rm -f -- "$key_candidate_file"; test ! -e "$key_candidate_file" && test ! -L "$key_candidate_file" || exit 70; elif test -e "$key_file" || test -L "$key_file"; then created_key_identity=; secure_private_regular_file_proof "$key_file"; else exit 43; fi;',
    "fi",
  ].join(" ");
  const durableKeyCommands = replacementAttemptId
    ? [
        `key_file=${keyFile}`,
        "created_key_identity=",
        createFencedDurableKeyCommand,
        'secure_private_regular_file_proof "$key_file"',
        'key_identity_before=$(secure_stat_identity "$key_file")',
        'if test -n "$created_key_identity"; then test "$key_identity_before" = "$created_key_identity" || exit 70; fi',
        'exec 7<"$key_file"',
        "secure_private_regular_fd_proof 7",
        "key_fd_identity=$(secure_fd_stat_identity 7)",
        "key_fd_fingerprint_before=$(secure_fd_stat_fingerprint 7)",
        'secure_private_regular_file_proof "$key_file"',
        'test "$(secure_stat_identity "$key_file")" = "$key_fd_identity" || exit 70',
        'test "$key_identity_before" = "$key_fd_identity" || exit 70',
        'secure_reset_file "$vault_snapshot_file"',
        'exec 8>>"$vault_snapshot_file"',
        "cat <&7 >&8",
        "key_fd_fingerprint_after=$(secure_fd_stat_fingerprint 7)",
        'secure_private_regular_file_proof "$key_file"',
        'test "$(secure_stat_identity "$key_file")" = "$key_fd_identity" || exit 70',
        'test "$key_fd_fingerprint_before" = "$key_fd_fingerprint_after" || exit 70',
        "exec 7<&-",
        "exec 8>&-",
        'secure_private_regular_file_proof "$vault_snapshot_file"',
        'secure_private_regular_file_proof "$vault_snapshot_file"',
        "line_count=$(awk 'END { print NR }' \"$vault_snapshot_file\")",
        'if test "$line_count" != 1; then exit 43; fi',
        'secure_reset_file "$normalized_file"',
        'exec 8>>"$normalized_file"',
        'secure_private_regular_file_proof "$vault_snapshot_file"',
        "tr -d '\\n' < \"$vault_snapshot_file\" >&8",
        "exec 8>&-",
        'secure_private_regular_file_proof "$normalized_file"',
        'secure_private_regular_file_proof "$normalized_file"',
        "key_length=$(wc -c < \"$normalized_file\" | tr -d ' ')",
        'secure_private_regular_file_proof "$normalized_file"',
        "safe_length=$(LC_ALL=C tr -d '[:space:][:cntrl:]' < \"$normalized_file\" | wc -c | tr -d ' ')",
        'if test "$key_length" -lt 12 || test "$key_length" != "$safe_length"; then exit 43; fi',
        'secure_private_regular_file_proof "$normalized_file"',
        'secure_private_regular_file_proof "$vault_snapshot_file"',
        'if ! cmp -s "$normalized_file" "$vault_snapshot_file"; then mv -- "$normalized_file" "$vault_snapshot_file"; fi',
        'secure_private_regular_file_proof "$vault_snapshot_file"',
        'if test -s "$override_file"; then secure_private_regular_file_proof "$override_file"; secure_private_regular_file_proof "$vault_snapshot_file"; if ! cmp -s "$override_file" "$vault_snapshot_file"; then exit 42; fi; fi',
        "vault_snapshot_ready=1",
      ]
    : [
        `key_file=${keyFile}`,
        'if test -e "$key_file" || test -L "$key_file"; then secure_regular_file_proof "$key_file"; else secure_reset_file "$generated_file"; exec 8>>"$generated_file"; if test -s "$override_file"; then secure_private_regular_file_proof "$override_file"; exec 7<"$override_file"; cat <&7 >&8; exec 7<&-; else head -c 32 /dev/urandom | od -An -tx1 | tr -d \' \\n\' >&8; fi; exec 8>&-; secure_private_regular_file_proof "$generated_file"; if ln "$generated_file" "$key_file" 2>/dev/null; then rm -f -- "$generated_file"; elif test -e "$key_file" || test -L "$key_file"; then secure_regular_file_proof "$key_file"; else exit 43; fi; fi',
        'secure_regular_file_proof "$key_file"',
        'chmod 600 "$key_file"',
        'secure_private_regular_file_proof "$key_file"',
        'secure_private_regular_file_proof "$key_file"',
        "line_count=$(awk 'END { print NR }' \"$key_file\")",
        'if test "$line_count" != 1; then exit 43; fi',
        'secure_reset_file "$normalized_file"',
        'exec 8>>"$normalized_file"',
        'secure_private_regular_file_proof "$key_file"',
        "tr -d '\\n' < \"$key_file\" >&8",
        "exec 8>&-",
        'secure_private_regular_file_proof "$normalized_file"',
        'secure_private_regular_file_proof "$normalized_file"',
        "key_length=$(wc -c < \"$normalized_file\" | tr -d ' ')",
        'secure_private_regular_file_proof "$normalized_file"',
        "safe_length=$(LC_ALL=C tr -d '[:space:][:cntrl:]' < \"$normalized_file\" | wc -c | tr -d ' ')",
        'if test "$key_length" -lt 12 || test "$key_length" != "$safe_length"; then exit 43; fi',
        'secure_private_regular_file_proof "$normalized_file"',
        'secure_private_regular_file_proof "$key_file"',
        'if ! cmp -s "$normalized_file" "$key_file"; then mv "$normalized_file" "$key_file"; fi',
        'secure_regular_file_proof "$key_file"',
        'chmod 600 "$key_file"',
        'secure_private_regular_file_proof "$key_file"',
        'if test -s "$override_file"; then secure_private_regular_file_proof "$override_file"; secure_private_regular_file_proof "$key_file"; if ! cmp -s "$override_file" "$key_file"; then exit 42; fi; fi',
      ];
  return [
    "set -eu",
    `stdin_file=${stdinFile}`,
    `override_file=${overrideFile}`,
    `generated_file=${generatedFile}`,
    `normalized_file=${normalizedFile}`,
    ...(keyCandidateFile ? [`key_candidate_file=${keyCandidateFile}`] : []),
    ...(vaultSnapshotFile
      ? [`vault_snapshot_file=${vaultSnapshotFile}`, "vault_snapshot_ready=0"]
      : []),
    "umask 077",
    ...(replacementAttemptId
      ? [
          ...replacementAttemptControlPrelude(replacementAttemptId),
          'test ! -e "$attempt_cancelled" && test ! -L "$attempt_cancelled" || exit 75',
          'chmod 600 -- "$attempt_lock"',
          ...fencedPreparationCommands,
        ]
      : secureFileShellPrelude("$(id -u)")),
    cleanupFunction,
    "trap cleanup_vault_temp_files EXIT",
    "trap 'exit 1' HUP INT TERM",
    'secure_reset_file "$stdin_file"',
    'exec 8>>"$stdin_file"',
    "cat >&8",
    "exec 8>&-",
    'secure_private_regular_file_proof "$stdin_file"',
    'secure_private_regular_file_proof "$stdin_file"',
    `stdin_length=$(wc -c < "$stdin_file" | tr -d ' ')`,
    `if test "$stdin_length" != ${expectedFrameByteLength}; then exit 44; fi`,
    'secure_private_regular_file_proof "$stdin_file"',
    `frame_header=$(sed -n '1p' "$stdin_file")`,
    `if test "$frame_header" != ${shellQuote(expectedHeader)}; then exit 44; fi`,
    'secure_private_regular_file_proof "$stdin_file"',
    "frame_lines=$(awk 'END { print NR }' \"$stdin_file\")",
    'if test "$frame_lines" != 3; then exit 44; fi',
    'secure_private_regular_file_proof "$stdin_file"',
    `if test "$(tail -n 1 "$stdin_file")" != ${shellQuote(VOLUME_VAULT_STDIN_FRAME_END)}; then exit 44; fi`,
    'secure_reset_file "$override_file"',
    'exec 8>>"$override_file"',
    'secure_private_regular_file_proof "$stdin_file"',
    "sed '1d;$d' \"$stdin_file\" >&8",
    "exec 8>&-",
    'secure_private_regular_file_proof "$override_file"',
    'secure_private_regular_file_proof "$override_file"',
    "override_framed_length=$(wc -c < \"$override_file\" | tr -d ' ')",
    'if test "$override_framed_length" -lt 1; then exit 44; fi',
    'secure_private_regular_file_proof "$override_file"',
    'truncate -s -1 "$override_file"',
    'secure_private_regular_file_proof "$override_file"',
    "override_length=$(wc -c < \"$override_file\" | tr -d ' ')",
    `if test "$override_length" != ${overrideByteLength}; then exit 44; fi`,
    'if test -s "$override_file"; then secure_private_regular_file_proof "$override_file"; override_safe_length=$(LC_ALL=C tr -d \'[:space:][:cntrl:]\' < "$override_file" | wc -c | tr -d \' \'); if test "$override_length" -lt 12 || test "$override_length" != "$override_safe_length"; then exit 43; fi; fi',
    ...durableKeyCommands,
  ].join("; ");
}

/**
 * Run {@link buildVolumeVaultPassphraseCommand} through an stdin-capable node
 * shell and validate the result remotely. Fails closed on a short or empty
 * key — a fresh random per-launch key would silently orphan every
 * credential already encrypted on the volume.
 *
 * `operatorOverride` (an injected `ELIZA_VAULT_PASSPHRASE`) is not allowed to
 * bypass this lifecycle: the persisted key file stays the single source of
 * truth across container replacement. A first provision seeds the file with
 * the override, so a later replacement launched WITHOUT the override reads
 * the same key instead of minting a fresh one that cannot decrypt the
 * volume's existing vault ciphertext. If the file already holds a different
 * key, provisioning fails closed rather than guessing which key encrypted
 * the ciphertext.
 */
export async function ensureVolumeVaultPassphrase(
  execStdin: (cmd: string, input: string, timeoutMs: number) => Promise<string>,
  volumePath: string,
  timeoutMs: number,
  operatorOverride?: string,
  replacementAttemptId?: string,
): Promise<void> {
  // Validate the raw value before trim or SSH. Shell variables cannot carry
  // NUL, and the remote create-if-absent step may durably link its stdin file
  // before raw-file validation runs. No control-bearing candidate may reach
  // that mutation boundary.
  if (
    operatorOverride !== undefined &&
    Array.from(operatorOverride).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new ElizaError(
      `[docker-sandbox] injected vault override is unusable (length ${operatorOverride.length}); refusing to seed ${getVolumeVaultPassphrasePath(volumePath)} with a key the vault would reject`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_UNUSABLE",
        context: { volumePath, passphraseLength: operatorOverride.length },
      },
    );
  }
  // Empty/whitespace-only override means "not set" — same as the historical
  // `environmentVars.ELIZA_VAULT_PASSPHRASE?.trim() ||` fallthrough.
  const override = operatorOverride?.trim() || undefined;
  if (override !== undefined && (override.length < 12 || /\s/.test(override))) {
    // Validate BEFORE seeding: persisting an unusable override would brick
    // every subsequent launch on the post-write length check below.
    throw new ElizaError(
      `[docker-sandbox] injected vault override is unusable (length ${override.length}); refusing to seed ${getVolumeVaultPassphrasePath(volumePath)} with a key the vault would reject`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_UNUSABLE",
        context: { volumePath, passphraseLength: override.length },
      },
    );
  }
  const overrideBytes = Buffer.byteLength(override ?? "", "utf8");
  const framedOverride = `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${overrideBytes}\n${override ?? ""}\n${VOLUME_VAULT_STDIN_FRAME_END}\n`;
  try {
    // Keep temporary artifacts attributable to the caller-owned attempt so
    // exact cleanup can prove that plaintext did not outlive the fence.
    await execStdin(
      buildVolumeVaultPassphraseCommand(volumePath, overrideBytes, replacementAttemptId),
      framedOverride,
      timeoutMs,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const exitCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    if (exitCode === 42 || message.includes("exited with code 42")) {
      throw new ElizaError(
        `[docker-sandbox] injected vault override does not match the key persisted at ${getVolumeVaultPassphrasePath(volumePath)}; that file remains the durable source of truth`,
        {
          code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_MISMATCH",
          context: { volumePath },
          cause,
        },
      );
    }
    if (exitCode === 43 || message.includes("exited with code 43")) {
      throw new ElizaError(
        `[docker-sandbox] persisted vault passphrase at ${getVolumeVaultPassphrasePath(volumePath)} is unusable; refusing to mint a fresh per-launch key`,
        {
          code: "SANDBOX_VAULT_PASSPHRASE_UNUSABLE",
          context: { volumePath },
          cause,
        },
      );
    }
    if (exitCode === 44 || message.includes("exited with code 44")) {
      throw new ElizaError(
        `[docker-sandbox] vault passphrase transport to ${getVolumeVaultPassphrasePath(volumePath)} was incomplete or invalid; refusing to change durable vault state`,
        {
          code: "SANDBOX_VAULT_PASSPHRASE_STDIN_INCOMPLETE",
          context: { volumePath },
          cause,
        },
      );
    }
    throw cause;
  }
}

/** Unique restrictive env file used only for one remote `docker create`. */
export function getContainerSecretEnvPath(
  volumePath: string,
  replacementAttemptId: string,
): string {
  validateVolumePath(volumePath);
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  return `${volumePath}/.container-env-${replacementAttemptId}`;
}

/**
 * Tombstone one replacement attempt, then remove and prove absence of every
 * attributable plaintext file. The Docker-active marker is deliberately not
 * cleared here: after an interrupted `docker create`, only observing and
 * removing the exact labeled candidate can settle the daemon-side ambiguity.
 */
export function buildReplacementSecretArtifactsCleanupCommand(
  containerName: string,
  replacementAttemptId: string,
  exactVolumePath?: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  const volumePath = exactVolumePath ?? getReplacementVolumePath(containerName);
  if (exactVolumePath !== undefined) {
    validateContainerName(containerName);
    validateVolumePath(exactVolumePath);
  }
  const secretEnvPath = getReplacementControlSecretEnvPath(replacementAttemptId);
  const secretEnvBodyPath = `${secretEnvPath}.body`;
  const legacySecretEnvPath = getContainerSecretEnvPath(volumePath, replacementAttemptId);
  const legacyVaultPassphrasePath = getVolumeVaultPassphrasePath(volumePath);
  const artifactPaths = [
    secretEnvPath,
    secretEnvBodyPath,
    getReplacementControlVaultPassphrasePath(replacementAttemptId),
    ...(["stdin", "override", "generated", "normalized"] as const).map((kind) =>
      getReplacementControlVaultArtifactPath(replacementAttemptId, kind),
    ),
    legacySecretEnvPath,
    `${legacySecretEnvPath}.body`,
    ...(["stdin", "override", "generated", "normalized"] as const).map(
      (kind) => `${legacyVaultPassphrasePath}.${kind}.${replacementAttemptId}`,
    ),
    getVolumeVaultPassphrasePublicationCandidatePath(volumePath, replacementAttemptId),
  ];
  const existingArtifactProof = artifactPaths
    .map(
      (path) =>
        `if test -e ${shellQuote(path)}; then secure_private_regular_file_proof ${shellQuote(path)}; fi`,
    )
    .join("; ");
  const cleanupTargets = artifactPaths.map(shellQuote).join(" ");
  const absenceProof = artifactPaths
    .map(
      (path) => `if test -e ${shellQuote(path)} || test -L ${shellQuote(path)}; then exit 70; fi`,
    )
    .join("; ");
  const receipt = getReplacementSecretArtifactsCleanupReceipt(replacementAttemptId);
  const quiescentReceipt = getReplacementDockerCreateQuiescentReceipt(replacementAttemptId);
  const candidateReceiptPrefix = `${REPLACEMENT_CANDIDATE_OBSERVED_RECEIPT} ${replacementAttemptId}`;
  return [
    "set -eu",
    "umask 077",
    ...replacementAttemptControlPrelude(replacementAttemptId),
    'secure_reset_control_file "$attempt_cancelled"',
    'exec 8>>"$attempt_cancelled"',
    'printf "%s\\n" cancelled >&8',
    "exec 8>&-",
    'secure_private_regular_file_proof "$attempt_cancelled"',
    'chmod 600 -- "$attempt_lock"',
    existingArtifactProof,
    `rm -f -- ${cleanupTargets} "$attempt_docker_error"`,
    absenceProof,
    `printf '%s\\n' ${shellQuote(receipt)}`,
    'if test -e "$attempt_active" || test -L "$attempt_active"; then secure_private_regular_file_proof "$attempt_active"; else ' +
      `printf '%s\\n' ${shellQuote(quiescentReceipt)}; fi`,
    'if test -e "$attempt_candidate_id" || test -L "$attempt_candidate_id"; then secure_private_regular_file_proof "$attempt_candidate_id"; candidate_id=$(cat -- "$attempt_candidate_id"); case "$candidate_id" in ""|*[!0-9a-f]*) exit 70 ;; esac; candidate_id_length=${#candidate_id}; if test "$candidate_id_length" -lt 12 || test "$candidate_id_length" -gt 64; then exit 70; fi; ' +
      `printf '%s %s\\n' ${shellQuote(candidateReceiptPrefix)} "$candidate_id"; fi`,
  ].join("; ");
}

/**
 * Delete only the canonical staging directory of one abandoned exact restore.
 *
 * The caller must boot-fence this command and run it only after attempting to
 * remove the exact Docker candidate. The attempt flock serializes this proof
 * with vault seeding and Docker create; the durable tombstone remains in the
 * control directory so a response-lost replay cannot recreate the volume.
 */
export function buildExactRestoreStagingVolumeCleanupCommand(
  containerName: string,
  replacementAttemptId: string,
  exactVolumePath: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  validateContainerName(containerName);
  validateVolumePath(exactVolumePath);
  const match = /^agent-restore-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(containerName);
  if (!match) {
    throw new ElizaError("Exact restore staging cleanup requires a canonical container name.", {
      code: "SANDBOX_EXACT_RESTORE_STAGING_CLEANUP_IDENTITY_INVALID",
      severity: "fatal",
    });
  }
  const agentId = match[1]!;
  const restoreAttemptId = match[2]!;
  assertCanonicalReplacementPathAttemptId(agentId);
  assertCanonicalReplacementPathAttemptId(restoreAttemptId);
  const expectedVolumePath = `/data/agents/.restore/${agentId}/${restoreAttemptId}`;
  if (exactVolumePath !== expectedVolumePath) {
    throw new ElizaError(
      "Exact restore staging cleanup path differs from its container identity.",
      {
        code: "SANDBOX_EXACT_RESTORE_STAGING_CLEANUP_PATH_INVALID",
        severity: "fatal",
      },
    );
  }

  const restoreRoot = "/data/agents/.restore";
  const agentRoot = `${restoreRoot}/${agentId}`;
  const receipt = getExactRestoreStagingVolumeCleanupReceipt(
    replacementAttemptId,
    restoreAttemptId,
  );
  const safeDirectoryProof = (path: string, optional: boolean): string => {
    const quoted = shellQuote(path);
    const proof =
      `test -d ${quoted} && test ! -L ${quoted} || exit 76; ` +
      `test "$(stat -c '%u' -- ${quoted})" = 0 || exit 76; ` +
      `directory_mode=$(stat -c '%a' -- ${quoted}); ` +
      'case "$directory_mode" in *[2367][0-7]|*[0-7][2367]) exit 76 ;; esac';
    return optional ? `if test -e ${quoted} || test -L ${quoted}; then ${proof}; fi` : proof;
  };
  const volume = shellQuote(exactVolumePath);
  return [
    "set -eu",
    "umask 077",
    "command -v docker >/dev/null 2>&1",
    "command -v stat >/dev/null 2>&1",
    "command -v findmnt >/dev/null 2>&1",
    ...replacementAttemptControlPrelude(replacementAttemptId),
    'secure_private_regular_file_proof "$attempt_cancelled" 75',
    'if test -e "$attempt_active" || test -L "$attempt_active"; then secure_private_regular_file_proof "$attempt_active" 76; secure_private_regular_file_proof "$attempt_candidate_id" 76; fi',
    'if test -e "$attempt_candidate_id" || test -L "$attempt_candidate_id"; then secure_private_regular_file_proof "$attempt_candidate_id" 76; candidate_id=$(cat -- "$attempt_candidate_id"); case "$candidate_id" in ""|*[!0-9a-f]*) exit 76 ;; esac; test "${#candidate_id}" = 64 || exit 76; candidate_matches=$(docker container ls -aq --no-trunc --filter "id=$candidate_id"); test -z "$candidate_matches" || exit 76; fi',
    `name_matches=$(docker container ls -aq --no-trunc --filter ${shellQuote(`name=^/${containerName}$`)}); test -z "$name_matches" || exit 76`,
    `all_container_ids=$(docker container ls -aq --no-trunc); for existing_id in $all_container_ids; do mount_sources=$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$existing_id"); if printf '%s\n' "$mount_sources" | awk -v root=${volume} 'length($0) > 0 && ($0 == root || index($0, root "/") == 1 || $0 == "/" || index(root, $0 "/") == 1) { found=1 } END { exit found ? 0 : 1 }'; then exit 76; fi; done`,
    safeDirectoryProof("/data", false),
    safeDirectoryProof("/data/agents", false),
    safeDirectoryProof(restoreRoot, false),
    safeDirectoryProof(agentRoot, true),
    `if test -L ${volume}; then exit 76; fi`,
    `if test -e ${volume}; then ${safeDirectoryProof(exactVolumePath, false)}; mount_inventory=$(findmnt -rn -o FSROOT,TARGET) || exit 76; if printf '%s\n' "$mount_inventory" | awk -v root=${volume} '$1 == root || index($1, root "/") == 1 || $2 == root || index($2, root "/") == 1 { found=1 } END { exit found ? 0 : 1 }'; then exit 76; fi; rm -rf --one-file-system -- ${volume}; fi`,
    `if test -e ${volume} || test -L ${volume}; then exit 76; fi`,
    `if test -e ${shellQuote(agentRoot)} && test ! -L ${shellQuote(agentRoot)}; then rmdir -- ${shellQuote(agentRoot)} 2>/dev/null || :; fi`,
    'secure_private_regular_file_proof "$attempt_cancelled" 75',
    'if test -e "$attempt_active" || test -L "$attempt_active"; then secure_private_regular_file_proof "$attempt_active" 76; secure_private_regular_file_proof "$attempt_candidate_id" 76; fi',
    `printf '%s\n' ${shellQuote(receipt)}`,
  ].join("; ");
}

/**
 * Persist the exact Docker ID already observed with this attempt's label.
 * Cleanup writes this before removal so a response-lost retry can distinguish
 * "the known candidate is now absent" from an unsafe first observation of
 * name absence while dockerd may still commit an interrupted create.
 */
export function buildReplacementCandidateObservedCommand(
  replacementAttemptId: string,
  containerId: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  assertCanonicalDockerContainerId(containerId);
  const receipt = getReplacementCandidateObservedReceipt(replacementAttemptId, containerId);
  return [
    "set -eu",
    "umask 077",
    ...replacementAttemptControlPrelude(replacementAttemptId),
    'secure_private_regular_file_proof "$attempt_cancelled" 75',
    'if test -e "$attempt_candidate_id" || test -L "$attempt_candidate_id"; then secure_private_regular_file_proof "$attempt_candidate_id"; test "$(cat -- "$attempt_candidate_id")" = ' +
      `${shellQuote(containerId)} || exit 70; else candidate_tmp="$attempt_dir/candidate-id.tmp"; secure_reset_control_file "$candidate_tmp"; exec 8>>"$candidate_tmp"; printf '%s\\n' ${shellQuote(containerId)} >&8; exec 8>&-; secure_private_regular_file_proof "$candidate_tmp"; mv -- "$candidate_tmp" "$attempt_candidate_id"; fi`,
    'secure_private_regular_file_proof "$attempt_candidate_id"',
    `test "$(cat -- "$attempt_candidate_id")" = ${shellQuote(containerId)}`,
    `printf '%s\\n' ${shellQuote(receipt)}`,
  ].join("; ");
}

/** Read the full Docker ID durably recorded by one fenced create producer. */
export function buildReplacementCreatedContainerIdProofCommand(
  replacementAttemptId: string,
): string {
  assertCanonicalReplacementPathAttemptId(replacementAttemptId);
  return [
    "set -eu",
    ...replacementAttemptControlPrelude(replacementAttemptId),
    'test ! -e "$attempt_cancelled" && test ! -L "$attempt_cancelled" || exit 75',
    'secure_private_regular_file_proof "$attempt_candidate_id"',
    'candidate_id=$(cat -- "$attempt_candidate_id")',
    'case "$candidate_id" in ""|*[!0-9a-f]*) exit 70 ;; esac',
    'test "${#candidate_id}" = 64',
    'printf "%s\\n" "$candidate_id"',
  ].join("; ");
}

/**
 * Wrap `docker create` so stdin becomes a 0600 env file, the persisted vault
 * value is appended without being read by the caller, and every shell exit
 * removes the file. A cleanup failure after an otherwise-successful create is
 * reported as non-zero so callers cannot mistake persisted plaintext for an
 * exact completion.
 */
export function buildDockerCreateWithSecretEnvCommand(options: {
  dockerCreateCommand: string;
  secretEnvPath: string;
  vaultPassphrasePath: string;
  exactReplacement?: {
    containerName: string;
    replacementAttemptId: string;
    /** Alternate exact volume derivation used only by restore staging. */
    volumePath?: string;
    /** Persist the full Docker ID before the secret-bearing channel settles. */
    recordContainerId?: true;
  };
}): string {
  const replacementAttemptId = options.exactReplacement?.replacementAttemptId;
  if (options.exactReplacement) {
    const exactVolumePath =
      options.exactReplacement.volumePath ??
      getReplacementVolumePath(options.exactReplacement.containerName);
    validateVolumePath(exactVolumePath);
    const expectedPath = getReplacementControlSecretEnvPath(
      options.exactReplacement.replacementAttemptId,
    );
    if (options.secretEnvPath !== expectedPath) {
      throw new ElizaError("Exact replacement secret environment path is not canonical.", {
        code: "SANDBOX_REPLACEMENT_SECRET_ENV_PATH_NONCANONICAL",
        context: {
          containerName: options.exactReplacement.containerName,
          replacementAttemptId: options.exactReplacement.replacementAttemptId,
        },
        severity: "fatal",
      });
    }
    const expectedVaultPath = getReplacementControlVaultPassphrasePath(
      options.exactReplacement.replacementAttemptId,
    );
    if (options.vaultPassphrasePath !== expectedVaultPath) {
      throw new ElizaError("Exact replacement vault snapshot path is not canonical.", {
        code: "SANDBOX_REPLACEMENT_VAULT_SNAPSHOT_PATH_NONCANONICAL",
        context: {
          containerName: options.exactReplacement.containerName,
          replacementAttemptId: options.exactReplacement.replacementAttemptId,
        },
        severity: "fatal",
      });
    }
  }
  const envFile = shellQuote(options.secretEnvPath);
  const envBodyFile = shellQuote(`${options.secretEnvPath}.body`);
  const vaultFile = shellQuote(options.vaultPassphrasePath);
  const fenced = replacementAttemptId !== undefined;
  const cleanupTargets = fenced
    ? '"$env_file" "$env_body_file" "$vault_file"'
    : '"$env_file" "$env_body_file"';
  const cleanupFunction =
    `cleanup_secret_env_files() { cleanup_status=$?; if ! rm -f -- ${cleanupTargets}; then if test "$cleanup_status" -eq 0; then cleanup_status=70; fi; fi; ` +
    'if test -e "$env_file" || test -L "$env_file" || test -e "$env_body_file" || test -L "$env_body_file"' +
    (fenced ? ' || test -e "$vault_file" || test -L "$vault_file"' : "") +
    '; then if test "$cleanup_status" -eq 0; then cleanup_status=70; fi; fi; ' +
    (fenced
      ? 'if test "$cleanup_status" -eq 0; then if ! rm -f -- "$attempt_active"; then cleanup_status=70; elif test -e "$attempt_active" || test -L "$attempt_active"; then cleanup_status=70; fi; fi; '
      : "") +
    'trap - EXIT; exit "$cleanup_status"; }';
  const definitiveDockerFailurePatterns = [
    "Conflict. The container name",
    "is already in use by container",
    "invalid reference format",
    "No such image",
    "invalid mount config",
    "invalid volume specification",
    "unknown flag:",
  ]
    .map((marker) => `-e ${shellQuote(marker)}`)
    .join(" ");
  const clearDefinitiveDockerFailure = fenced
    ? `secure_private_regular_file_proof "$attempt_docker_error"; if grep -F ${definitiveDockerFailurePatterns} -- "$attempt_docker_error" >/dev/null 2>&1; then rm -f -- "$attempt_active" || exit 70; test ! -e "$attempt_active" && test ! -L "$attempt_active" || exit 70; fi`
    : ":";
  const dockerCreateCommand = options.exactReplacement?.recordContainerId
    ? [
        'exec 8>>"$attempt_docker_error"',
        `if candidate_id=$(${options.dockerCreateCommand} 2>&8); then docker_status=0; else docker_status=$?; fi`,
        "exec 8>&-",
        'secure_private_regular_file_proof "$attempt_docker_error"',
        `if test "$docker_status" -ne 0; then ${clearDefinitiveDockerFailure}; rm -f -- "$attempt_docker_error"; exit "$docker_status"; fi`,
        'rm -f -- "$attempt_docker_error"',
        'test ! -e "$attempt_docker_error" && test ! -L "$attempt_docker_error" || exit 70',
        'case "$candidate_id" in ""|*[!0-9a-f]*) exit 70 ;; esac',
        'test "${#candidate_id}" = 64',
        'candidate_tmp="$attempt_dir/candidate-id.tmp"',
        'secure_reset_control_file "$candidate_tmp"',
        'exec 8>>"$candidate_tmp"',
        'printf "%s\\n" "$candidate_id" >&8',
        "exec 8>&-",
        'secure_private_regular_file_proof "$candidate_tmp"',
        'mv -- "$candidate_tmp" "$attempt_candidate_id"',
        'secure_private_regular_file_proof "$attempt_candidate_id"',
      ].join("; ")
    : fenced
      ? [
          'exec 8>>"$attempt_docker_error"',
          `if ${options.dockerCreateCommand} 2>&8; then docker_status=0; else docker_status=$?; fi`,
          "exec 8>&-",
          'secure_private_regular_file_proof "$attempt_docker_error"',
          `if test "$docker_status" -ne 0; then ${clearDefinitiveDockerFailure}; rm -f -- "$attempt_docker_error"; exit "$docker_status"; fi`,
          'rm -f -- "$attempt_docker_error"',
          'test ! -e "$attempt_docker_error" && test ! -L "$attempt_docker_error" || exit 70',
        ].join("; ")
      : options.dockerCreateCommand;
  return [
    "set -eu",
    `env_file=${envFile}`,
    `env_body_file=${envBodyFile}`,
    `vault_file=${vaultFile}`,
    "umask 077",
    ...(replacementAttemptId
      ? [
          ...replacementAttemptControlPrelude(replacementAttemptId),
          'test ! -e "$attempt_cancelled" && test ! -L "$attempt_cancelled" || exit 75',
          'chmod 600 -- "$attempt_lock"',
        ]
      : secureFileShellPrelude("$(id -u)")),
    cleanupFunction,
    "trap cleanup_secret_env_files EXIT",
    "trap 'exit 1' HUP INT TERM",
    'secure_reset_file "$env_file"',
    'exec 8>>"$env_file"',
    "cat >&8",
    "exec 8>&-",
    'secure_private_regular_file_proof "$env_file"',
    'secure_private_regular_file_proof "$env_file"',
    `test "$(tail -n 1 "$env_file")" = ${shellQuote(CONTAINER_SECRET_ENV_STDIN_SENTINEL)}`,
    'secure_reset_file "$env_body_file"',
    'exec 8>>"$env_body_file"',
    'secure_private_regular_file_proof "$env_file"',
    "sed '$d' \"$env_file\" >&8",
    "exec 8>&-",
    'secure_private_regular_file_proof "$env_body_file"',
    'mv "$env_body_file" "$env_file"',
    'secure_private_regular_file_proof "$env_file"',
    'truncate -s -1 "$env_file"',
    'secure_private_regular_file_proof "$env_file"',
    'secure_private_regular_file_proof "$vault_file"',
    'exec 7<"$vault_file"',
    'exec 8>>"$env_file"',
    "cat <&7 >&8",
    "printf '\\n' >&8",
    "exec 7<&-",
    "exec 8>&-",
    'secure_private_regular_file_proof "$env_file"',
    ...(replacementAttemptId
      ? [
          'secure_reset_control_file "$attempt_docker_error"',
          'secure_reset_control_file "$attempt_active"',
        ]
      : []),
    dockerCreateCommand,
  ].join("; ");
}

// ---------------------------------------------------------------------------
// Node Configuration Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `CONTAINERS_DOCKER_NODES` (or legacy `AGENT_DOCKER_NODES`) env var.
 * Format: `nodeId:hostname:capacity,nodeId2:hostname2:capacity2`
 *
 * Result is cached at module level to avoid re-parsing on every call.
 */
let _cachedDockerNodes: DockerNodeEnv[] | null = null;
let _cachedDockerNodesRaw: string | undefined;

export function parseDockerNodes(): DockerNodeEnv[] {
  const raw = containersEnv.seedNodes();
  if (!raw) {
    throw new Error(
      "[docker-sandbox] No seed nodes configured. " +
        "Set CONTAINERS_DOCKER_NODES (or legacy AGENT_DOCKER_NODES) " +
        'in the format "nodeId:hostname:capacity,..."',
    );
  }

  // Return cached result if env var hasn't changed
  if (_cachedDockerNodes && _cachedDockerNodesRaw === raw) {
    return _cachedDockerNodes;
  }

  const nodes: DockerNodeEnv[] = [];
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(":");
    if (parts.length < 3) {
      logger.warn(`[docker-sandbox] Skipping malformed node entry: "${trimmed}"`);
      continue;
    }

    const [nodeId, hostname, capacityStr] = parts;
    const capacity = parseInt(capacityStr!, 10);
    if (!nodeId || !hostname || isNaN(capacity) || capacity <= 0) {
      logger.warn(`[docker-sandbox] Skipping invalid node entry: "${trimmed}"`);
      continue;
    }

    nodes.push({ nodeId, hostname, capacity });
  }

  if (nodes.length === 0) {
    throw new Error("[docker-sandbox] No valid nodes parsed from AGENT_DOCKER_NODES");
  }

  _cachedDockerNodes = nodes;
  _cachedDockerNodesRaw = raw;
  return nodes;
}

/**
 * Which Headscale teardown applies to a container's VPN state (#16565).
 * During a blue/green overlap old and new nodes share the deterministic
 * hostname, so:
 *  - a registered id is the only safe deletion handle (`by-id`);
 *  - preserve-mode with NO registered id means the container never joined —
 *    the only same-name node is the LIVE preserved one, and by-name deletion
 *    is forbidden (`skip-preserved`);
 *  - plain provisions without an id fall back to the historical by-name
 *    cleanup (`by-name`) — nothing ambiguous exists there.
 * Pure so every caller (stop teardown, create-failure rollback) shares one
 * pinned decision instead of re-deriving it.
 */
export function resolveVpnTeardown(state: {
  vpnNodeId?: string;
  previousVpnNodeId?: string;
}): { kind: "by-id"; nodeId: string } | { kind: "by-name" } | { kind: "skip-preserved" } {
  if (state.vpnNodeId) return { kind: "by-id", nodeId: state.vpnNodeId };
  if (state.previousVpnNodeId) return { kind: "skip-preserved" };
  return { kind: "by-name" };
}
