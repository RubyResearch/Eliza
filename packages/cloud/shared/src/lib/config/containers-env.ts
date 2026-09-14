/**
 * Container service env var resolution.
 *
 * Single source of truth for env vars consumed by the Hetzner-Docker
 * container control plane. Reads the canonical `CONTAINERS_*` /
 * `ELIZA_AGENT_*` names first and falls back to the legacy `AGENT_*`
 * names so existing deployments keep working during the rebrand.
 *
 * Add new env reads here, not at call sites.
 */

import * as fs from "node:fs";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

/**
 * Where the effective SSH private key for Docker-node connections resolves
 * from. Discriminated so a fail-fast startup check can branch without
 * re-reading env or duplicating the precedence rules.
 */
export type SshKeySource = { kind: "inline" } | { kind: "file"; path: string } | { kind: "none" };

function normalizeEnvValue(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n$/g, "")
    .trim();
}

/** Platform embedding model served by every fresh node's sidecar (see embeddingSidecarModelId). */
export const DEFAULT_EMBEDDING_SIDECAR_MODEL_ID = "BAAI/bge-small-en-v1.5";
/** Audited Hugging Face revision of the platform embedding model (1_Pooling: CLS, 384-dim). */
export const DEFAULT_EMBEDDING_SIDECAR_MODEL_REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

function pick(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeEnvValue(candidate);
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function parsePositiveIntList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function parseCanonicalPositiveIntSet(value: string | undefined, name: string): number[] {
  if (value === undefined) return [];
  const tokens = value.split(",").map((item) => item.trim());
  if (
    tokens.length === 0 ||
    tokens.some((item) => !/^[1-9]\d*$/.test(item) || !Number.isSafeInteger(Number(item)))
  ) {
    throw new Error(`${name} must be a comma-separated set of positive integer IDs`);
  }
  const ids = tokens.map(Number);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${name} must not contain duplicate IDs`);
  }
  return ids;
}

export const containersEnv = {
  /** Base64-encoded SSH private key for connecting to Docker nodes. */
  sshKey(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_SSH_KEY, env.AGENT_SSH_KEY);
  },

  /** Filesystem path to the SSH private key (used when sshKey() is unset). */
  sshKeyPath(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_SSH_KEY_PATH, env.AGENT_SSH_KEY_PATH);
  },

  /**
   * Trust-On-First-Use host-key pinning for Docker nodes.
   *
   * When a node's `host_key_fingerprint` is NULL (never pinned), the SSH client
   * accepts the key presented on the FIRST successful connect and hands it back
   * via `onHostKeyDiscovered` so the caller can persist it to `docker_nodes`.
   * Subsequent connects are verified against the now-pinned fingerprint, and a
   * MISMATCH is ALWAYS refused regardless of this flag (a mismatch is a possible
   * MITM, never a first-use).
   *
   * DEFAULT: ON. Every staging node currently ships with a NULL pin, so a
   * fail-closed "refuse every unpinned key" policy hard-bricks the whole fleet
   * (the outage this fixes). TOFU-on lets the fleet self-pin on first contact
   * while still catching key CHANGES afterwards. Security can flip it off with
   * `CONTAINERS_SSH_TOFU_PIN=false` once every node carries a pin, which
   * restores strict fail-closed behavior for unpinned hosts.
   *
   * Read via `CONTAINERS_SSH_TOFU_PIN` (with the `ELIZA_` fallback that matches
   * the other container flags); only the literal string `"false"`/`"0"`
   * disables it.
   */
  sshTofuPinEnabled(): boolean {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_SSH_TOFU_PIN, env.ELIZA_CONTAINERS_SSH_TOFU_PIN);
    if (raw === undefined) return true;
    return raw !== "false" && raw !== "0";
  },

  /**
   * Resolve the EFFECTIVE SSH key source without loading key material — used by
   * fail-fast startup checks. Returns a discriminated result describing where a
   * usable key would come from, or that none is configured.
   *
   * - `{ kind: "inline" }`   — `CONTAINERS_SSH_KEY` (base64) is set inline.
   * - `{ kind: "file", path }` — a key path is configured (existence is checked
   *   by the caller so this stays a pure env read).
   * - `{ kind: "none" }`     — neither an inline key nor a path is configured.
   */
  resolveSshKeySource(): SshKeySource {
    if (this.sshKey()) return { kind: "inline" };
    const path = this.sshKeyPath();
    if (path) return { kind: "file", path };
    return { kind: "none" };
  },

  /** SSH user for connecting to Docker nodes. Defaults to "root". */
  sshUser(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_SSH_USER, env.AGENT_SSH_USER, env.ELIZA_SSH_USER) ?? "root";
  },

  /** Docker network name created on every node. Containers attach to this. */
  dockerNetwork(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_DOCKER_NETWORK, env.AGENT_DOCKER_NETWORK) ?? "containers-isolated";
  },

  /**
   * Image for the per-node local-embedding sidecar (text-embeddings-inference,
   * CPU build). Pinned to a known tag rather than `latest` so every node in the
   * fleet runs the same server; bump deliberately via this env.
   */
  embeddingSidecarImage(): string {
    const env = getCloudAwareEnv();
    return (
      pick(env.CONTAINERS_EMBEDDING_SIDECAR_IMAGE, env.ELIZA_EMBEDDING_SIDECAR_IMAGE) ??
      "ghcr.io/huggingface/text-embeddings-inference:cpu-1.8"
    );
  },

  /**
   * Model the embedding sidecar serves. The platform standard is
   * BAAI/bge-small-en-v1.5 (384-dim, CLS pooling, L2-normalized) — the same
   * model the on-device `plugin-local-inference` path and Workers AI serve, so
   * vectors stay comparable across sidecar, device and cloud when pooling is
   * explicit. Same width is NOT the same space: a node that still holds
   * gte-small stores must keep `CONTAINERS_EMBEDDING_SIDECAR_MODEL_ID=
   * thenlper/gte-small` pinned until each agent has had a scoped backup +
   * fresh-index cutover; the runtime's embedding store identity guard refuses
   * to write a different model into an existing same-width store.
   */
  embeddingSidecarModelId(): string {
    const env = getCloudAwareEnv();
    return (
      pick(env.CONTAINERS_EMBEDDING_SIDECAR_MODEL_ID, env.ELIZA_EMBEDDING_SIDECAR_MODEL_ID) ??
      DEFAULT_EMBEDDING_SIDECAR_MODEL_ID
    );
  },

  /**
   * Hugging Face revision the sidecar pins. Defaults to the audited revision
   * of the platform model and to unpinned for any other model id unless the
   * operator sets one — a model swap must never silently drift revisions.
   */
  embeddingSidecarModelRevision(): string | null {
    const env = getCloudAwareEnv();
    const explicit = pick(
      env.CONTAINERS_EMBEDDING_SIDECAR_MODEL_REVISION,
      env.ELIZA_EMBEDDING_SIDECAR_MODEL_REVISION,
    );
    if (explicit) return explicit;
    return this.embeddingSidecarModelId() === DEFAULT_EMBEDDING_SIDECAR_MODEL_ID
      ? DEFAULT_EMBEDDING_SIDECAR_MODEL_REVISION
      : null;
  },

  /**
   * Pooling TEI applies. bge-small-en-v1.5 is a CLS-pooled model and CLS and
   * mean vectors are incompatible (Cloudflare's Workers AI defaults to mean),
   * so the platform model is pinned to `cls` explicitly; other models fall back
   * to TEI's own model-config detection unless the operator sets a pooling.
   */
  embeddingSidecarPooling(): string | null {
    const env = getCloudAwareEnv();
    const explicit = pick(
      env.CONTAINERS_EMBEDDING_SIDECAR_POOLING,
      env.ELIZA_EMBEDDING_SIDECAR_POOLING,
    );
    if (explicit) return explicit;
    return this.embeddingSidecarModelId() === DEFAULT_EMBEDDING_SIDECAR_MODEL_ID ? "cls" : null;
  },

  /**
   * Loopback host port the sidecar publishes on each node (127.0.0.1 only —
   * the node-side health probe curls it; agents use the bridge network, and
   * nothing is reachable off-node). Default 8290. Clamped to [1, 65535].
   */
  embeddingSidecarHostPort(): number {
    const env = getCloudAwareEnv();
    const raw = pick(
      env.CONTAINERS_EMBEDDING_SIDECAR_HOST_PORT,
      env.ELIZA_EMBEDDING_SIDECAR_HOST_PORT,
    );
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 8290;
  },

  /**
   * Whether the node health loop may (re)install a missing embedding sidecar.
   *
   * DEFAULT: ON — the durable remediation this exists for: nodes provisioned
   * before the sidecar shipped in bootstrap converge on the next health cycle
   * instead of waiting for a hand-install (the failure mode that lost the
   * fleet's sidecars in the first place). The health verdict is persisted
   * either way, so disabling self-heal (`false`/`0`) still surfaces absence.
   */
  embeddingSidecarSelfHealEnabled(): boolean {
    const env = getCloudAwareEnv();
    const raw = pick(
      env.CONTAINERS_EMBEDDING_SIDECAR_SELF_HEAL,
      env.ELIZA_EMBEDDING_SIDECAR_SELF_HEAL,
    );
    return raw !== "false" && raw !== "0";
  },

  /** Username used for Docker registry pulls on container nodes. */
  registryUsername(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(
      env.CONTAINERS_REGISTRY_USERNAME,
      env.ELIZA_APP_IMAGE_REGISTRY_USERNAME,
      env.GHCR_USERNAME,
      env.GITHUB_ACTOR,
    );
  },

  /** Token used for Docker registry pulls on container nodes. */
  registryToken(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_REGISTRY_TOKEN, env.ELIZA_APP_IMAGE_REGISTRY_TOKEN, env.GHCR_TOKEN);
  },

  /** Filesystem path to a Docker registry token for container node pulls. */
  registryTokenFile(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_REGISTRY_TOKEN_FILE, env.ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE);
  },

  /**
   * Default agent image when a caller asks for the canonical Eliza agent
   * flavor without specifying a tag. Operators can pin a specific tag here
   * without code changes.
   */
  defaultAgentImage(): string {
    return this.defaultAgentImageOverride() ?? "ghcr.io/elizaos/eliza:stable";
  },

  /** Image used by coding-container requests that need the remote runner HTTP contract. */
  codingRemoteRunnerImage(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(
      env.ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE,
      env.ELIZA_CODING_REMOTE_RUNNER_IMAGE,
      env.CONTAINERS_CODING_REMOTE_RUNNER_IMAGE,
    );
  },

  /**
   * Allowlist of image refs/prefixes permitted for coding-container deploys.
   *
   * SECURITY: coding-containers let an authenticated org run an OUTSIDE
   * image (e.g. `ghcr.io/dexploarer/bnancy:latest`). Without an allowlist any
   * authed org could run an arbitrary image on our nodes. This is the gate.
   *
   * Format: comma-separated glob prefixes, e.g.
   *   `ghcr.io/dexploarer/*,ghcr.io/elizaos/*,ghcr.io/waifufun/*`
   * A trailing `*` matches any suffix (repo path, tag, digest). An entry with
   * no `*` must match the image exactly. Matching is case-insensitive on the
   * registry/repo and ignores surrounding whitespace.
   *
   * Returns the parsed, normalized list. Empty list = allowlist disabled
   * (handled at the call site so an unset env doesn't silently open the gate;
   * see `isCodingContainerImageAllowed`).
   *
   * NOTE: the default entries (ghcr.io/dexploarer/*, ghcr.io/elizaos/*,
   * ghcr.io/waifufun/*) are first-party namespaces. Review these if GitHub org
   * access changes for any of those organizations.
   */
  codingContainerImageAllowlist(): string[] {
    const env = getCloudAwareEnv();
    const raw = pick(
      env.CODING_CONTAINER_IMAGE_ALLOWLIST,
      env.ELIZA_CODING_CONTAINER_IMAGE_ALLOWLIST,
      env.CONTAINERS_CODING_IMAGE_ALLOWLIST,
    );
    if (raw === undefined) {
      // Secure-by-default starter set. Operators override via env.
      return ["ghcr.io/dexploarer/*", "ghcr.io/elizaos/*", "ghcr.io/waifufun/*"];
    }
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  },

  /**
   * Allowlist of image refs/prefixes permitted for APPS-DEPLOY (Product 2) image
   * deploys — DELIBERATELY SEPARATE from {@link codingContainerImageAllowlist}.
   *
   * Apps-deploy ships ONLY first-party template/app images under
   * `ghcr.io/elizaos/*`, so its default allowlist is `ghcr.io/elizaos/*` and
   * nothing else — no personal (`ghcr.io/dexploarer/*`) or side-product
   * (`ghcr.io/waifufun/*`) namespaces. Those stay on the coding-container
   * allowlist (its BYO-image path), and an operator can opt them back in for
   * apps-deploy by setting `APPS_DEPLOY_IMAGE_ALLOWLIST` explicitly.
   *
   * Format + matching rules are identical to the coding allowlist
   * (comma-separated glob prefixes; trailing `*` = prefix match; no `*` = exact;
   * a bare `*` opts out). Returns the parsed, normalized list; an empty list
   * disables the gate at parse time, but the call site
   * (`isCodingContainerImageAllowed`) is fail-closed, so an explicit empty env
   * denies every apps-deploy image rather than silently opening the gate.
   */
  appsDeployImageAllowlist(): string[] {
    const env = getCloudAwareEnv();
    const raw = pick(env.APPS_DEPLOY_IMAGE_ALLOWLIST);
    if (raw === undefined) {
      // First-party elizaOS images only. Operators widen via env.
      return ["ghcr.io/elizaos/*"];
    }
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  },

  /**
   * Allowlist of image refs/prefixes permitted for the MANAGED-AGENT lane
   * (`POST /api/v1/eliza/agents` → `elizaSandboxService.createAgent`), enforced
   * in the shared `createAgent` path so every route inherits it (H1, #12230).
   *
   * SECURITY: the managed-agent route accepts a caller-supplied `dockerImage`
   * validated only by a permissive regex, then `docker pull`/`docker run`s it on
   * the shared fleet. Without this gate any authenticated org could run an
   * arbitrary image next to other tenants. This is that gate.
   *
   * DELIBERATELY SEPARATE from {@link codingContainerImageAllowlist}: managed
   * agents ship ONLY the first-party runtime image, so the default is
   * `ghcr.io/elizaos/*` and nothing else — NOT the coding lane's broader BYO set
   * (`ghcr.io/dexploarer/*`, `ghcr.io/waifufun/*`). Operators widen via
   * `AGENT_IMAGE_ALLOWLIST`.
   *
   * Format + matching rules are identical to the other allowlists
   * (comma-separated glob prefixes; trailing `*` = prefix match; no `*` = exact;
   * a bare `*` opts out). The call site ({@link isCodingContainerImageAllowed})
   * is fail-closed, so an explicit empty env denies every managed-agent custom
   * image rather than silently opening the gate.
   */
  agentImageAllowlist(): string[] {
    const env = getCloudAwareEnv();
    const raw = pick(env.AGENT_IMAGE_ALLOWLIST, env.ELIZA_AGENT_IMAGE_ALLOWLIST);
    if (raw === undefined) {
      // First-party elizaOS runtime images only. Operators widen via env.
      return ["ghcr.io/elizaos/*"];
    }
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  },

  /**
   * Org ids whose agent containers are TEST containers (QA accounts, e2e
   * harness orgs). Containers provisioned for these orgs get the docker label
   * `ai.elizaos.container-class=test` so fleet janitors and CI teardown can
   * reap them without ever touching a real user's agent. Comma-separated
   * UUIDs via `CONTAINERS_TEST_ORG_IDS` (with `ELIZA_` fallback); empty by
   * default — unlisted orgs are always classed `user`, the safe direction.
   */
  testOrgIds(): string[] {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_TEST_ORG_IDS, env.ELIZA_TEST_ORG_IDS);
    if (raw === undefined) return [];
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  },

  /**
   * First-party TEMPLATE image stamped onto a template app (one created WITHOUT a
   * user repo) at create time, so create -> deploy resolves to a prebuilt,
   * allowlisted image instead of failing with "no image to deploy".
   *
   * Defaults to the retained `:showcase` template image. It sits under
   * `ghcr.io/elizaos/*`, so the apps-deploy allowlist permits it unchanged.
   * Override the whole ref via `APP_DEFAULT_TEMPLATE_IMAGE`.
   *
   * TODO(ops, digest-pin): `:showcase` is a MUTABLE tag — the registry could
   * re-point it after the deploy-time allowlist check. Once a stable showcase
   * digest is published, pin this default to
   * `ghcr.io/elizaos/example-edad@sha256:<64hex>` so a future digest-pin gate
   * (`CONTAINER_IMAGE_REQUIRE_DIGEST`) accepts the template default unchanged.
   */
  appDefaultTemplateImage(): string {
    const env = getCloudAwareEnv();
    return pick(env.APP_DEFAULT_TEMPLATE_IMAGE) ?? "ghcr.io/elizaos/example-edad:showcase";
  },

  /**
   * Whether image refs must be pinned to a full `@sha256:<64hex>` digest to be
   * accepted by the container image gate (in addition to the allowlist).
   *
   * SECURITY: a mutable tag (`:latest`, `:stable`, or an implicit latest) lets
   * the registry swap the bytes behind an allowed name after the gate passes.
   * Requiring a digest pin makes the accepted image content-addressed.
   *
   * OPT-IN, default OFF everywhere — enabling it in prod would reject the
   * current first-party `:tag`/`:latest` deploys, so it must NOT be flipped on
   * until those images are themselves digest-pinned (a separate ops step).
   * Read via `CONTAINER_IMAGE_REQUIRE_DIGEST` (with `ELIZA_`/`CONTAINERS_`
   * fallbacks); only the literal string `"true"` enables it.
   */
  requireDigestPinnedImages(): boolean {
    const env = getCloudAwareEnv();
    return (
      pick(
        env.CONTAINER_IMAGE_REQUIRE_DIGEST,
        env.ELIZA_CONTAINER_IMAGE_REQUIRE_DIGEST,
        env.CONTAINERS_IMAGE_REQUIRE_DIGEST,
      ) === "true"
    );
  },

  /**
   * Auto-recover a node whose dockerd coordinator has wedged. Repeated failed
   * pre-pulls and a deletion whose stop plus force-remove both time out may use
   * the same bounded daemon restart instead of requiring manual intervention.
   * The running daemon must confirm live restore before mutation; configuration
   * alone is insufficient, and an unavailable proof requires operator recovery. Read via
   * `CONTAINERS_PREPULL_SELF_HEAL_RESTART` (with `ELIZA_` fallback); only the
   * literal string `"true"` enables it. Off by default — a docker restart is a
   * shared-host operation, so each environment opts in explicitly.
   */
  prePullSelfHealRestartEnabled(): boolean {
    const env = getCloudAwareEnv();
    return (
      pick(
        env.CONTAINERS_PREPULL_SELF_HEAL_RESTART,
        env.ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART,
      ) === "true"
    );
  },

  /**
   * Default per-agent container memory ceiling in MiB, applied by the docker
   * provisioner whenever a sandbox has no explicit `container.memory` of its
   * own. `0` disables the ceiling entirely (pre-2026-08 behavior).
   *
   * Why a default exists at all: agent containers previously ran with
   * `HostConfig.Memory=0` (unlimited) plus `--restart unless-stopped`. One
   * agent stuck in a boot loop — each boot attempt spiking ~2GB before dying —
   * could starve an entire node and get HEALTHY co-tenant agents OOM-killed
   * (observed fleet-wide on staging 2026-08-05: node `available` memory driven
   * to 4MB, kernel OOM killing unrelated agents every ~10-30s).
   *
   * Default: 6144 MiB. Restoring a persisted runtime and exporting its next
   * snapshot require headroom beyond boot-time RSS. Placement and bootstrap
   * capacity use this same ceiling with a separate host reserve; the paid
   * single-agent ccx13 profile remains 8 GiB. Clamped to [0, 65536].
   */
  agentContainerMemoryLimitMb(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_AGENT_MEMORY_LIMIT_MB, env.ELIZA_AGENT_MEMORY_LIMIT_MB);
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(65536, Math.floor(parsed));
    }
    return 6144;
  },

  /**
   * Per-agent-container `--cpus` ceiling (fractional cores). The CPU analog of
   * agentContainerMemoryLimitMb (#18485): robot-first placement packs far more
   * agents per box than the old 4-vCPU cloud nodes, so one busy-looping agent
   * must be throttled inside its own cgroup instead of starving co-tenants.
   *
   * Default: 2 — double the 1-vCPU/agent budget the capacity math is sized
   * around (DEFAULT_AGENT_VCPU_BUDGET), so a healthy agent can still burst
   * while a runaway one cannot monopolize a 12-core robot. 0 disables the
   * ceiling. Clamped to [0, 64]; fractional values are kept.
   */
  agentContainerCpuLimit(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_AGENT_CPU_LIMIT, env.ELIZA_AGENT_CPU_LIMIT);
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(64, parsed);
    }
    return 2;
  },

  /** Explicit operator-pinned agent image, without the hardcoded fallback. */
  defaultAgentImageOverride(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(
      env.ELIZA_AGENT_IMAGE,
      env.CONTAINERS_DEFAULT_IMAGE,
      env.AGENT_DOCKER_IMAGE,
      env.ELIZA_DOCKER_IMAGE,
    );
  },

  /**
   * Platform for the canonical managed-agent image. The current production
   * image is amd64-only, so autoscaled nodes must be x86 unless operators
   * explicitly publish/configure a multi-arch image.
   */
  defaultAgentImagePlatform(): string | undefined {
    const env = getCloudAwareEnv();
    return (
      pick(
        env.ELIZA_AGENT_IMAGE_PLATFORM,
        env.CONTAINERS_DEFAULT_IMAGE_PLATFORM,
        env.AGENT_DOCKER_PLATFORM,
        env.ELIZA_DOCKER_PLATFORM,
      ) ?? "linux/amd64"
    );
  },

  /**
   * Seed-only fallback list of nodes used before any node is registered
   * via `POST /api/v1/admin/docker-nodes`.
   * Format: `nodeId:hostname:capacity,nodeId2:hostname2:capacity2`.
   */
  seedNodes(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_DOCKER_NODES, env.AGENT_DOCKER_NODES);
  },

  /** Application port baked into the canonical Eliza agent image. */
  agentPort(): string {
    const env = getCloudAwareEnv();
    return pick(env.ELIZA_AGENT_PORT, env.AGENT_AGENT_PORT) ?? "3000";
  },

  /** Bridge port the agent listens on inside the container (for agent-server bridge). */
  agentBridgePort(): string {
    const env = getCloudAwareEnv();
    return (
      pick(
        env.ELIZA_AGENT_BRIDGE_PORT,
        env.AGENT_BRIDGE_INTERNAL_PORT,
        env.ELIZA_BRIDGE_INTERNAL_PORT,
      ) ?? "31337"
    );
  },

  /** Legacy "ELIZA_PORT" — kept as a transitional env var for the agent image. */
  legacyContainerPort(): string {
    const env = getCloudAwareEnv();
    return pick(env.AGENT_CONTAINER_PORT) ?? "2138";
  },

  /**
   * Hetzner Cloud API token for elastic node provisioning. Optional.
   * Canonical name is `HCLOUD_TOKEN` (matches the official Hetzner CLI +
   * Terraform provider). The legacy aliases `HETZNER_CLOUD_TOKEN` and
   * `HETZNER_CLOUD_API_KEY` were dropped — one source of truth avoids the
   * silent divergence we hit during the multi-project migration (one
   * variable swapped, the other still pointing at the old project, so the
   * autoscaler spawned a worker in the wrong Hetzner project).
   */
  hetznerCloudToken(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.HCLOUD_TOKEN);
  },

  /**
   * SECURITY (H4, #12882): extra trusted FULL DATABASE_URLs permitted for the
   * forwarded `x-eliza-cloud-database-url` header, on TOP of the sidecar's own
   * configured `DATABASE_URL` (which is always trusted).
   *
   * The control-plane forward path lets the Cloud Worker pin a per-request
   * database. The sidecar must NOT connect to an arbitrary caller-named DB, so
   * `evaluateForwardedDatabaseUrl` fail-closes against this pinned set. The
   * match pins the WHOLE identity (scheme, credentials, host, port, database,
   * query), so entries here must be complete DATABASE_URLs, not bare hosts. A
   * bare host has no database/credentials identity and will never match. Most
   * deployments never need this (the forwarded URL == the sidecar's own
   * `DATABASE_URL`); it exists only for multi-DB topologies where the Worker
   * legitimately forwards a different-but-known database.
   *
   * Format: whitespace/comma-separated full DATABASE_URLs. Unparseable entries
   * are dropped and never widen the allowlist.
   */
  containerControlPlaneDatabaseUrlAllowlist(): string[] {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINER_CONTROL_PLANE_DATABASE_URL_ALLOWLIST);
    if (raw === undefined) return [];
    return raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  },

  /** The sidecar's own configured control-plane database URL, if any. */
  containerControlPlaneDatabaseUrl(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.DATABASE_URL);
  },

  /**
   * Cloud deployment environment (`staging`, `production`, `local`, …).
   *
   * Stamped onto provisioned Hetzner servers via the `environment` label so
   * the orchestrator/scheduler can scope per-env operations from the API
   * (`?label_selector=environment=staging`) and never act on a node from a
   * different environment.
   *
   * Defaults to `"local"` to match the other env-prefixed callers
   * (cache client, a2a task store, credit-events) — same fallback, same
   * source of truth (the `ENVIRONMENT` env var).
   */
  environment(): string {
    const env = getCloudAwareEnv();
    return pick(env.ENVIRONMENT) ?? "local";
  },

  /**
   * Base domain for per-container public hostnames (e.g.
   * `cloud.eliza.app`). When set, every new container gets
   * `<short-id>.<base-domain>` written to `public_hostname` and is
   * surfaced in the ingress map. Operators run a reverse proxy that
   * resolves these to the corresponding node:port upstream.
   */
  publicBaseDomain(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_PUBLIC_BASE_DOMAIN, env.ELIZA_CLOUD_AGENT_BASE_DOMAIN);
  },

  /**
   * Apps-only base domain for per-app public hostnames. Reads
   * `CONTAINERS_PUBLIC_BASE_DOMAIN` (set to e.g. `apps.eliza.app` on the apps
   * data plane by the apps-data-plane terraform) with NO fallback to the agent
   * sandbox domain (`ELIZA_CLOUD_AGENT_BASE_DOMAIN`) — unlike
   * {@link publicBaseDomain}. So an app never silently inherits the agent
   * sandbox domain; an unset value surfaces as "no URL" instead of a wrong-domain one.
   */
  appsPublicBaseDomain(): string | undefined {
    return getCloudAwareEnv().CONTAINERS_PUBLIC_BASE_DOMAIN || undefined;
  },

  /**
   * Explicit arming flag for BUILD-FROM-REPO (the "Vercel-like" path where the
   * platform builds an UNTRUSTED user Dockerfile into an image).
   *
   * SECURITY: a malicious Dockerfile can attack the dockerd it builds on. Even
   * with the throwaway-isolated-builder mitigation (see app-build-cmd.ts), the
   * build still launches a BuildKit container via SOME dockerd — so building on a
   * node that also hosts tenant containers keeps a residual blast radius. This
   * flag is the canary gate: build-from-repo stays OFF unless explicitly armed
   * AND a dedicated builder host (`buildsHost()`) is configured, OR the operator
   * opts into building on the runtime node by setting
   * `APPS_BUILD_ON_RUNTIME_NODE=1`. Default OFF (prebuilt-image path only).
   */
  buildFromRepoEnabled(): boolean {
    const env = getCloudAwareEnv();
    const raw = pick(env.APPS_BUILD_FROM_REPO_ENABLED);
    return raw === "true" || raw === "1";
  },

  /**
   * Dedicated builder host (`hostname` or `nodeId:hostname:capacity`) that runs
   * untrusted app builds, DISTINCT from any node hosting tenant containers. When
   * set, build-from-repo SSHes here instead of the runtime node, so a malicious
   * Dockerfile cannot reach co-tenant containers' daemon. Undefined = no
   * dedicated host (build-from-repo only runs if `APPS_BUILD_ON_RUNTIME_NODE=1`
   * explicitly opts into the runtime node).
   */
  buildsHost(): string | undefined {
    const env = getCloudAwareEnv();
    const raw = pick(env.APPS_BUILDS_HOST);
    if (!raw) return undefined;
    const parts = raw.split(":");
    const host = parts.length >= 2 ? parts[1]?.trim() : parts[0]?.trim();
    return host || undefined;
  },

  /**
   * Escape hatch: allow building untrusted Dockerfiles on the runtime node's
   * daemon (the one hosting tenant containers) when no dedicated builder host is
   * configured. OFF by default — opting in accepts the residual blast radius the
   * throwaway-isolated-builder mitigation narrows but does not eliminate.
   */
  buildOnRuntimeNodeAllowed(): boolean {
    const env = getCloudAwareEnv();
    const raw = pick(env.APPS_BUILD_ON_RUNTIME_NODE);
    return raw === "true" || raw === "1";
  },

  /**
   * Caddy admin-API base URL the daemon uses to add/remove per-app ingress routes
   * (e.g. `http://127.0.0.1:2019` over an SSH tunnel, or the app node's
   * private-IP admin endpoint). Undefined = ingress not wired (routes are no-ops).
   */
  caddyAdminUrl(): string | undefined {
    return getCloudAwareEnv().APPS_CADDY_ADMIN_URL || undefined;
  },

  /**
   * Default Hetzner Cloud location for provisioning nodes and volumes
   * (e.g. "fsn1", "nbg1", "hel1"). Hetzner volumes are location-bound, so
   * the volume and the server it attaches to must share a location.
   * Defaults to "fsn1" (Falkenstein, DE) to match the existing prod fleet
   * — and because Hetzner deprecated cpx32 on "ash" (Ashburn) which made
   * the previous default fail with "unsupported location for server type".
   */
  defaultHcloudLocation(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_HCLOUD_LOCATION, env.HCLOUD_LOCATION) ?? "fsn1";
  },

  /**
   * Default Hetzner Cloud server type for elastic Docker nodes. Keep this on
   * x86 because the managed agent image defaults to linux/amd64.
   *
   * Default is ccx33 (8 dedicated vCPU / 32 GB) so the out-of-the-box pair
   * with the 8-agents/node default capacity gives ~4 GB/agent, well clear of
   * an OOM. The prior cpx32 (8 GB) default paired with the same capacity put
   * each agent on ~1 GB and was OOM-killed by the kernel under real load.
   *
   * ccx33 was picked over a same-sized shared type (e.g. cpx51) because the
   * Hetzner API actually rejects `cpx51` server creation in fsn1/nbg1/hel1
   * with `unsupported location for server type` even though /server_types
   * lists those locations in its prices array. Dedicated vCPU is also a
   * better fit for agent workloads (no noisy-neighbor throttling).
   */
  defaultHcloudServerType(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_HCLOUD_SERVER_TYPE, env.HCLOUD_SERVER_TYPE) ?? "ccx33";
  },

  defaultHcloudNetworkIds(): number[] {
    const env = getCloudAwareEnv();
    return parsePositiveIntList(pick(env.CONTAINERS_HCLOUD_NETWORK_IDS, env.HCLOUD_NETWORK_IDS));
  },

  /**
   * Exact Cloud Firewall set attached atomically to every runtime-created
   * Hetzner data-plane node. Missing configuration returns an empty set so the
   * provisioning boundary can emit its typed fail-closed error; malformed or
   * ambiguous values throw before any provider request is made.
   */
  defaultHcloudFirewallIds(): number[] {
    const env = getCloudAwareEnv();
    return parseCanonicalPositiveIntSet(
      pick(env.CONTAINERS_HCLOUD_FIREWALL_IDS, env.HCLOUD_FIREWALL_IDS),
      "CONTAINERS_HCLOUD_FIREWALL_IDS",
    );
  },

  /**
   * Legacy per-node policy fallback for newly autoscaled Hetzner Cloud nodes.
   * It is retained in provisional metadata for operator visibility, while the
   * row itself stays at capacity zero until hardware reports RAM and vCPU.
   *
   * Env-overridable for compatibility with existing fleet configuration.
   * Default: 8. Hardware-attested capacity is derived by the bootstrap
   * callback and does not treat this fallback as an explicit request.
   *
   * Clamped to [1, 64].
   */
  defaultAutoscaleNodeCapacity(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_AUTOSCALE_NODE_CAPACITY);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? Math.min(64, Math.floor(parsed)) : 8;
  },

  /**
   * Free slots that must remain across the pool before a new node is
   * provisioned. Also acts as the drain preservation floor: a drain is
   * refused if it would leave the pool below this number of free slots.
   *
   * Default: 2 — half a 4-slot node kept hot across the pool. Bump via env
   * for fleets where the cold-start tail matters more than node cost.
   * Clamped to [0, 64].
   */
  autoscaleMinFreeSlotsBuffer(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_AUTOSCALE_MIN_FREE_SLOTS_BUFFER);
    const parsed = raw !== undefined ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(64, Math.floor(parsed)) : 2;
  },

  /**
   * Emergency floor for hot agent starts; bypasses scale-up cooldown when
   * pool availability drops below this. Clamped to [0, 64]. Default: 1.
   */
  autoscaleMinHotAvailableSlots(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_AUTOSCALE_MIN_HOT_AVAILABLE_SLOTS);
    const parsed = raw !== undefined ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(64, Math.floor(parsed)) : 1;
  },

  /**
   * Consecutive Docker command timeouts on one node before placement opens a
   * per-node circuit breaker. The provisioning worker is the sole placement
   * owner, so this bounds repeated pressure without adding a database write to
   * every Docker command. Default 2; clamped to [1, 10].
   */
  nodeDockerTimeoutFailureThreshold(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_NODE_DOCKER_TIMEOUT_FAILURE_THRESHOLD);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(10, Math.max(1, Math.floor(parsed))) : 2;
  },

  /**
   * Placement cooldown after a node trips its timeout or I/O-pressure circuit.
   * Default 5 minutes; clamped to [30s, 1h].
   */
  nodeCircuitBreakerCooldownMs(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_NODE_CIRCUIT_BREAKER_COOLDOWN_MS);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed)
      ? Math.min(60 * 60_000, Math.max(30_000, Math.floor(parsed)))
      : 5 * 60_000;
  },

  /**
   * Linux PSI `full avg60` percentage at which a reachable node is too
   * I/O-stalled for new placement. The outage in #17880 sustained ~78%; the
   * default 50 leaves substantial headroom while ignoring ordinary bursts.
   * Clamped to [1, 100]. Set 100 to effectively disable pressure rejection.
   */
  nodeIoPressureFullAvg60Threshold(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.CONTAINERS_NODE_IO_PRESSURE_FULL_AVG60_THRESHOLD);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 50;
  },

  // ── Warm pool ───────────────────────────────────────────────────────────

  /**
   * Maximum ordinary/canary agent image upgrades allowed in flight together.
   * Set to 0 to pause image churn during an operational canary such as a warm-
   * pool refill without carrying a source hot patch that the next deploy wipes.
   * Default: 3. Clamped to [0, 64].
   */
  maxInflightUpgrades(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.MAX_INFLIGHT_UPGRADES, env.CONTAINERS_MAX_INFLIGHT_UPGRADES);
    const parsed = raw !== undefined ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(64, Math.max(0, Math.floor(parsed))) : 3;
  },

  /**
   * Whether the agent warm pool is enabled. When false, claim flow always
   * falls through to the cold-start async path; replenish/drain crons stay inactive.
   * Default: false (opt-in).
   */
  warmPoolEnabled(): boolean {
    const env = getCloudAwareEnv();
    const raw = pick(env.WARM_POOL_ENABLED);
    return raw === "true" || raw === "1";
  },

  /**
   * Maximum number of pool containers ever provisioned. The forecast may
   * recommend more, but this is the hard ceiling on cost.
   * Default: 10.
   */
  warmPoolMaxSize(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.WARM_POOL_MAX_SIZE);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? Math.min(50, Math.floor(parsed)) : 10;
  },

  /**
   * Floor: the pool replenisher will keep at least this many containers
   * ready when the pool is enabled. Default: 1.
   */
  warmPoolMinSize(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.WARM_POOL_MIN_SIZE);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
  },

  // ── Node disk clean manager ───────────────────────────────────────────────

  /**
   * High-water mark (percent of the docker data-root filesystem used) at which
   * the disk clean manager reclaims space on a node: `docker system prune -af`
   * (no `--volumes`) + clear stuck containerd ingest + buildkit prune.
   *
   * ON by default — this is the missing self-management that keeps a node from
   * silently filling up on retried failed pulls. Default 80: leaves headroom
   * below the unhealthy threshold so prune runs (and usually recovers the node)
   * before disk-full ever flaps it unhealthy. Clamped to [50, 99].
   */
  nodeDiskPruneThresholdPct(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.NODE_DISK_PRUNE_THRESHOLD_PCT);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(99, Math.max(50, Math.floor(parsed))) : 80;
  },

  /**
   * Critical mark (percent used) at/above which a node is flagged UNHEALTHY by
   * the disk-aware health check so the autoscaler drains/replaces it rather than
   * trusting a `docker info` that still answers on a full disk.
   *
   * Sits ABOVE the prune threshold so a node only flaps unhealthy when prune
   * alone could not pull it back under water — conservative, no flapping.
   * Default 92. Clamped to [60, 99] and never below the prune threshold + 1.
   */
  nodeDiskUnhealthyThresholdPct(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.NODE_DISK_UNHEALTHY_THRESHOLD_PCT);
    const parsed = raw ? Number(raw) : Number.NaN;
    const value = Number.isFinite(parsed) ? Math.min(99, Math.max(60, Math.floor(parsed))) : 92;
    // Keep the unhealthy mark strictly above the prune mark so a node is always
    // given a chance to self-reclaim before being flapped unhealthy.
    return Math.max(value, this.nodeDiskPruneThresholdPct() + 1);
  },

  /**
   * Cooldown (ms) between consecutive prunes of the SAME node, so a node above
   * the threshold while a large pull is legitimately in flight is not pruned
   * every infra-maintenance tick. Default 30 min. Clamped to [60s, 6h].
   */
  nodeDiskPruneCooldownMs(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.NODE_DISK_PRUNE_COOLDOWN_MS);
    const parsed = raw ? Number(raw) : Number.NaN;
    const defaultMs = 30 * 60_000;
    return Number.isFinite(parsed)
      ? Math.min(6 * 60 * 60_000, Math.max(60_000, Math.floor(parsed)))
      : defaultMs;
  },

  /**
   * Cadence for the managed-agent image GC that removes old, unused refs from
   * the configured default-agent repository. It is deliberately separate from
   * the emergency high-water prune so large nodes shed superseded image tags
   * before they ever cross the disk-full threshold. Default 24h. Clamped to
   * [1h, 7d].
   */
  nodeDiskAgentImagePruneIntervalMs(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.NODE_DISK_AGENT_IMAGE_PRUNE_INTERVAL_MS);
    const parsed = raw ? Number(raw) : Number.NaN;
    const defaultMs = 24 * 60 * 60_000;
    return Number.isFinite(parsed)
      ? Math.min(7 * 24 * 60 * 60_000, Math.max(60 * 60_000, Math.floor(parsed)))
      : defaultMs;
  },

  /**
   * Number of newest managed-agent image refs to preserve on each node even when
   * unused. Keeping two refs gives operators the current image plus a quick
   * rollback cushion while still pruning long-tail tag/digest buildup. Default
   * 2. Clamped to [1, 10].
   */
  nodeDiskAgentImagePruneKeepNewest(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.NODE_DISK_AGENT_IMAGE_PRUNE_KEEP_NEWEST);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(10, Math.max(1, Math.floor(parsed))) : 2;
  },

  /**
   * Minimum age for an unused managed-agent image ref before stale-image GC may
   * delete it. This avoids racing fresh deploys or rollback tags that landed
   * shortly before the cleanup cycle. Default 7d. Clamped to [24h, 90d].
   */
  nodeDiskAgentImagePruneMaxAgeHours(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.NODE_DISK_AGENT_IMAGE_PRUNE_MAX_AGE_HOURS);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(90 * 24, Math.max(24, Math.floor(parsed))) : 7 * 24;
  },
};

/**
 * Fail-fast: assert that a USABLE SSH private key will be available before the
 * provisioning worker starts SSHing into nodes.
 *
 * Key resolution is lazy (first SSH op, ~30s into the poll loop), so without
 * this check a worker with a missing key file starts, publishes a HEALTHY
 * heartbeat, then silently fails EVERY node SSH forever while still looking
 * alive. This turns that into a loud crash at boot (the daemon's systemd
 * `Restart=always` then relaunches it, and the failure is visible instead of
 * masked).
 *
 * Precedence mirrors `DockerSSHClient.resolvePrivateKey`:
 *   1. inline `CONTAINERS_SSH_KEY` (base64) — accepted without touching disk;
 *   2. else `CONTAINERS_SSH_KEY_PATH` must point at an existing, readable file;
 *   3. else nothing is configured → throw.
 *
 * Throws (never exits) so the caller owns the process lifecycle.
 */
export function assertSSHKeyAvailable(): void {
  const source = containersEnv.resolveSshKeySource();
  switch (source.kind) {
    case "inline":
      return;
    case "file":
      try {
        fs.accessSync(source.path, fs.constants.R_OK);
      } catch {
        const safePath = source.path.split("/").pop() ?? "unknown";
        throw new Error(
          `SSH key unavailable at .../${safePath}: CONTAINERS_SSH_KEY_PATH is set but the file is missing or unreadable, ` +
            `and no inline CONTAINERS_SSH_KEY is set. Every node SSH will fail. ` +
            `Set CONTAINERS_SSH_KEY (base64) or fix the key path.`,
        );
      }
      return;
    case "none":
      throw new Error(
        "SSH key unavailable: neither CONTAINERS_SSH_KEY (base64 inline) nor CONTAINERS_SSH_KEY_PATH is set. " +
          "Every node SSH will fail. Configure one before starting the provisioning worker.",
      );
  }
}
