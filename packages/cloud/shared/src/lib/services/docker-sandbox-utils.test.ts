/**
 * Exercises Docker sandbox utilities with deterministic cloud-shared fixtures.
 * This is a bun:test lane because the package Vitest config owns only the
 * direct-wallet integration surface.
 */
import { describe, expect, test } from "bun:test";
import {
  allocatePort,
  buildAgentContainerLabelArgs,
  buildAgentContainerLabelFlags,
  buildDockerContainerEnvTransport,
  buildDockerCreateWithSecretEnvCommand,
  buildExactRestoreStagingVolumeCleanupCommand,
  buildReplacementCandidateObservedCommand,
  buildReplacementCreatedContainerIdProofCommand,
  buildReplacementSecretArtifactsCleanupCommand,
  buildVolumeVaultPassphraseCommand,
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
  inferArchitectureFromHetznerServerType,
  isArchitectureCompatibleWithPlatform,
  isSecretContainerEnvKey,
  normalizeDockerArchitecture,
  readDockerHostPortFromMetadata,
  requiredArchitectureForPlatform,
  requiresDockerHostGateway,
  resolveAgentContainerClass,
  resolveStewardContainerUrl,
  resolveVpnTeardown,
  shellQuote,
  VOLUME_VAULT_STDIN_FRAME_END,
  VOLUME_VAULT_STDIN_FRAME_VERSION,
  validateAgentId,
  validateContainerName,
  validateEnvKey,
  validateEnvValue,
  validateVolumePath,
} from "./docker-sandbox-utils";

/**
 * These helpers build the shell commands and Docker arguments that provision
 * untrusted agent sandboxes on remote nodes. Every validator here is a shell-
 * injection / path-traversal boundary: a gap lets an agent id or env value
 * break out of single-quoting and run arbitrary commands on the host.
 */

describe("shellQuote", () => {
  test("wraps in single quotes and neutralizes embedded quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    // a closing quote + injected command must be defused, not passed through.
    expect(shellQuote("a'; rm -rf /")).toBe(`'a'"'"'; rm -rf /'`);
  });
});

describe("validateAgentId / validateContainerName", () => {
  test("rejects shell metacharacters, control chars, and overflow", () => {
    expect(() => validateAgentId("good-agent_1")).not.toThrow();
    expect(() => validateAgentId("")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("a;b")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("a\nb")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("x".repeat(200))).toThrow(/Invalid agent ID/);
  });

  test("container name must start alphanumeric and stay shell-safe", () => {
    expect(() => validateContainerName("agent-abc.1")).not.toThrow();
    expect(() => validateContainerName("-bad")).toThrow();
    expect(() => validateContainerName("has space")).toThrow();
  });
});

describe("validateEnvKey / validateEnvValue", () => {
  test("keys must be identifier-shaped", () => {
    expect(() => validateEnvKey("MY_KEY")).not.toThrow();
    expect(() => validateEnvKey("_x1")).not.toThrow();
    expect(() => validateEnvKey("1BAD")).toThrow(/Invalid environment variable key/);
    expect(() => validateEnvKey("BAD-KEY")).toThrow(/Invalid environment variable key/);
  });

  test("values reject control chars (newline-injected payloads)", () => {
    expect(() => validateEnvValue("K", "a normal value")).not.toThrow();
    expect(() => validateEnvValue("K", "line1\nline2")).toThrow(/contains control characters/);
  });
});

describe("secret container environment transport (#22060)", () => {
  test("fails unknown and credential-like names closed to stdin", () => {
    for (const key of [
      "AGENT_SERVER_SHARED_SECRET",
      "AWS_ACCESS_ID",
      "CUSTOM_CREDENTIALS",
      "DATABASE_URL",
      "DISCORD_API_TOKEN",
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZA_API_TOKEN",
      "ELIZA_LOCAL_ROOT_KEY",
      "ELIZA_VAULT_PASSPHRASE",
      "JWT_SECRET",
      "OPENAI_API_KEY",
      "SANDBOX_REGISTRY_REDIS_TOKEN",
      "STEWARD_AGENT_TOKEN",
      "STEWARD_JWT",
      "STEWARD_REFRESH_SERVICE_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "TS_AUTHKEY",
    ]) {
      expect(isSecretContainerEnvKey(key)).toBe(true);
    }
    for (const key of [
      "AGENT_DISABLE_AUTO_API_TOKEN",
      "ELIZA_ALLOW_WS_QUERY_TOKEN",
      "ELIZA_DISABLE_AUTO_API_TOKEN",
    ]) {
      expect(isSecretContainerEnvKey(key)).toBe(false);
    }
  });

  test("serializes Docker env-file-safe bytes losslessly and rejects record splitting", () => {
    const safeValues = {
      API_KEY: "equals= spaces 'quotes' \\slashes\\ and trailing ",
      PRIVATE_SETTING: " leading whitespace",
    };
    const transport = buildDockerContainerEnvTransport(safeValues);
    for (const [key, value] of Object.entries(safeValues)) {
      expect(transport.secretInput).toContain(`${key}=${value}\n`);
    }
    for (const invalidValue of ["line\nfeed", "carriage\rreturn", "nul\0byte"]) {
      expect(() => buildDockerContainerEnvTransport({ API_KEY: invalidValue })).toThrow(
        /contains control characters/,
      );
      try {
        buildDockerContainerEnvTransport({ API_KEY: invalidValue });
      } catch (error) {
        expect(String(error)).not.toContain(invalidValue);
      }
    }
  });

  test("keeps secret keys and values out of the assembled Docker command", () => {
    const secretValues = {
      OPENAI_API_KEY: "openai-secret-value",
      STEWARD_AGENT_TOKEN: "steward-secret-value",
      DATABASE_URL: "postgres://user:password@example.invalid/db",
      SANDBOX_REGISTRY_REDIS_TOKEN: "redis-secret-value",
    };
    const transport = buildDockerContainerEnvTransport({
      PORT: "3000",
      AGENT_DISABLE_AUTO_API_TOKEN: "1",
      ...secretValues,
    });
    const secretEnvPath = getContainerSecretEnvPath(
      "/data/agents/agent-a",
      "12345678-1234-4234-8234-123456789abc",
    );
    const dockerCreate = [
      "docker create",
      ...transport.commandFlags,
      `--env-file ${shellQuote(secretEnvPath)}`,
      "image:latest",
    ].join(" ");
    const command = buildDockerCreateWithSecretEnvCommand({
      dockerCreateCommand: dockerCreate,
      secretEnvPath,
      vaultPassphrasePath: "/data/agents/agent-a/.vault-passphrase",
    });

    expect(command).toContain("-e 'AGENT_DISABLE_AUTO_API_TOKEN=1'");
    expect(command).toContain("--env-file");
    expect(command).toContain("umask 077");
    expect(command).toContain("chmod 600");
    expect(command).toContain("trap");
    expect(command).not.toContain("ELIZA_VAULT_PASSPHRASE");
    expect(command).not.toContain("PORT=3000");
    expect(transport.secretInput).toContain("PORT=3000");
    for (const [key, value] of Object.entries(secretValues)) {
      expect(command).not.toContain(key);
      expect(command).not.toContain(value);
      expect(transport.secretInput).toContain(`${key}=${value}`);
    }
  });

  test("removes the restrictive env file after Docker success and failure", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const volume = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-secret-env-"));
    const vaultPath = getVolumeVaultPassphrasePath(volume);
    fs.writeFileSync(vaultPath, "persisted-vault-value", { mode: 0o600 });

    for (const dockerCreateCommand of ["true", "false"]) {
      const secretEnvPath = `${volume}/container.env`;
      const command = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand,
        secretEnvPath,
        vaultPassphrasePath: vaultPath,
      });
      const secretInput = buildDockerContainerEnvTransport({ API_KEY: "stdin-only" }).secretInput;
      await new Promise<void>((resolve) => {
        const child = spawn("/bin/sh", ["-c", command]);
        child.on("close", () => resolve());
        child.stdin.end(secretInput);
      });
      expect(fs.existsSync(secretEnvPath)).toBe(false);
    }
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("fails a successful Docker create when secret-file cleanup is unresolved", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const volume = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-cleanup-failure-"));
    const vaultPath = getVolumeVaultPassphrasePath(volume);
    const secretEnvPath = `${volume}/container.env`;
    const secret = "cleanup-secret-sentinel";
    fs.writeFileSync(vaultPath, "persisted-vault-value", { mode: 0o600 });

    try {
      for (const scenario of [
        { dockerCreateCommand: "rm() { return 1; }; true", expectedCode: 70 },
        { dockerCreateCommand: "rm() { return 1; }; false", expectedCode: 1 },
      ]) {
        const command = buildDockerCreateWithSecretEnvCommand({
          dockerCreateCommand: scenario.dockerCreateCommand,
          secretEnvPath,
          vaultPassphrasePath: vaultPath,
        });
        const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
          const child = spawn("/bin/sh", ["-c", command]);
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk.toString()));
          child.stderr.on("data", (chunk) => (output += chunk.toString()));
          child.on("close", (code) => resolve({ code, output }));
          child.stdin.end(buildDockerContainerEnvTransport({ API_KEY: secret }).secretInput);
        });

        expect(result.code).toBe(scenario.expectedCode);
        expect(result.output).not.toContain(secret);
        expect(fs.existsSync(secretEnvPath)).toBe(true);
        fs.unlinkSync(secretEnvPath);
      }
    } finally {
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  test("fails closed and cleans up a truncated stdin stream without echoing secrets", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const volume = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-short-stdin-"));
    const vaultPath = getVolumeVaultPassphrasePath(volume);
    const secretEnvPath = `${volume}/container.env`;
    fs.writeFileSync(vaultPath, "persisted-vault-value", { mode: 0o600 });
    const command = buildDockerCreateWithSecretEnvCommand({
      dockerCreateCommand: "true",
      secretEnvPath,
      vaultPassphrasePath: vaultPath,
    });
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn("/bin/sh", ["-c", command]);
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk.toString()));
      child.stderr.on("data", (chunk) => (output += chunk.toString()));
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end("API_KEY=must-not-echo\n");
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.output).not.toContain("must-not-echo");
    expect(fs.existsSync(secretEnvPath)).toBe(false);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("signal interruption runs the env-file cleanup trap", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const volume = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-signal-cleanup-"));
    const vaultPath = getVolumeVaultPassphrasePath(volume);
    const secretEnvPath = `${volume}/container.env`;
    fs.writeFileSync(vaultPath, "persisted-vault-value", { mode: 0o600 });
    const command = buildDockerCreateWithSecretEnvCommand({
      dockerCreateCommand: "sleep 30",
      secretEnvPath,
      vaultPassphrasePath: vaultPath,
    });
    const child = spawn("/bin/sh", ["-c", command], { detached: true });
    child.stdin.end(buildDockerContainerEnvTransport({ API_KEY: "stdin-only" }).secretInput);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(secretEnvPath); attempt++) {
      await Bun.sleep(10);
    }
    expect(fs.existsSync(secretEnvPath)).toBe(true);
    process.kill(-child.pid!, "SIGTERM");
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(fs.existsSync(secretEnvPath)).toBe(false);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("coordinates exact plaintext producers and cleanup with one durable tombstone", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const containerName = getContainerName(agentId);
    const volumePath = getVolumePath(agentId);
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const secretEnvPath = getReplacementControlSecretEnvPath(attemptId);
    const vaultSnapshotPath = getReplacementControlVaultPassphrasePath(attemptId);
    const vaultCommand = buildVolumeVaultPassphraseCommand(volumePath, 0, attemptId);
    const dockerCommand = buildDockerCreateWithSecretEnvCommand({
      dockerCreateCommand: `docker create --env-file ${shellQuote(secretEnvPath)} image:latest`,
      secretEnvPath,
      vaultPassphrasePath: vaultSnapshotPath,
      exactReplacement: { containerName, replacementAttemptId: attemptId },
    });
    const cleanupCommand = buildReplacementSecretArtifactsCleanupCommand(containerName, attemptId);
    const candidateCommand = buildReplacementCandidateObservedCommand(attemptId, "a".repeat(64));

    for (const producer of [vaultCommand, dockerCommand]) {
      expect(producer).toContain("flock -w 30 9");
      expect(producer).toContain('test ! -e "$attempt_cancelled"');
      expect(producer).not.toMatch(/cat >\s*["']?\$/);
      expect(producer).not.toMatch(/sed [^;]+ > /);
    }
    expect(vaultCommand).not.toContain('secure_reset_control_file "$attempt_active"');
    expect(dockerCommand).toContain('secure_reset_control_file "$attempt_active"');
    expect(dockerCommand).not.toContain("stat -Lf");
    expect(vaultCommand).toContain(`/replacement-attempts/${attemptId}/vault-stdin`);
    expect(vaultCommand).not.toContain(".$$;");
    expect(cleanupCommand.indexOf('secure_reset_control_file "$attempt_cancelled"')).toBeLessThan(
      cleanupCommand.indexOf(`rm -f -- '${secretEnvPath}'`),
    );
    expect(cleanupCommand).toContain(secretEnvPath);
    expect(cleanupCommand).toContain(vaultSnapshotPath);
    for (const kind of ["stdin", "override", "generated", "normalized"]) {
      expect(cleanupCommand).toContain(`/replacement-attempts/${attemptId}/vault-${kind}`);
    }
    expect(cleanupCommand).toContain("if test -e");
    expect(cleanupCommand).toContain("|| test -L");
    expect(cleanupCommand).not.toContain('rm -f -- "$attempt_active"');
    expect(cleanupCommand).not.toContain("find ");
    expect(cleanupCommand).toContain(getReplacementSecretArtifactsCleanupReceipt(attemptId));
    expect(candidateCommand).toContain(
      getReplacementCandidateObservedReceipt(attemptId, "a".repeat(64)),
    );
    expect(candidateCommand).toContain('secure_private_regular_file_proof "$attempt_cancelled" 75');
  });

  test("fences restore-staging env input and durably records the full Docker ID", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const restoreAttemptId = "22222222-2222-4222-8222-222222222222";
    const replacementAttemptId = "33333333-3333-4333-8333-333333333333";
    const containerName = `agent-restore-${agentId}-${restoreAttemptId}`;
    const volumePath = `/data/agents/.restore/${agentId}/${restoreAttemptId}`;
    const secretEnvPath = getReplacementControlSecretEnvPath(replacementAttemptId);
    const createCommand = buildDockerCreateWithSecretEnvCommand({
      dockerCreateCommand: "docker create image@sha256:deadbeef",
      secretEnvPath,
      vaultPassphrasePath: getReplacementControlVaultPassphrasePath(replacementAttemptId),
      exactReplacement: {
        containerName,
        replacementAttemptId,
        volumePath,
        recordContainerId: true,
      },
    });
    const cleanupCommand = buildReplacementSecretArtifactsCleanupCommand(
      containerName,
      replacementAttemptId,
      volumePath,
    );
    const proofCommand = buildReplacementCreatedContainerIdProofCommand(replacementAttemptId);
    const volumeCleanupCommand = buildExactRestoreStagingVolumeCleanupCommand(
      containerName,
      replacementAttemptId,
      volumePath,
    );

    expect(createCommand).toContain('secure_reset_control_file "$attempt_active"');
    expect(createCommand).toContain("candidate_id=$(docker create");
    expect(createCommand).toContain('test "${#candidate_id}" = 64');
    expect(createCommand).toContain('mv -- "$candidate_tmp" "$attempt_candidate_id"');
    expect(cleanupCommand).toContain(secretEnvPath);
    expect(cleanupCommand).not.toContain(getVolumePath(agentId));
    expect(proofCommand).toContain('secure_private_regular_file_proof "$attempt_candidate_id"');
    expect(proofCommand).toContain('test "${#candidate_id}" = 64');
    expect(volumeCleanupCommand).toContain(
      'secure_private_regular_file_proof "$attempt_cancelled" 75',
    );
    expect(volumeCleanupCommand).toContain("flock -w 30 9");
    expect(volumeCleanupCommand).toContain("docker container ls -aq --no-trunc");
    expect(volumeCleanupCommand).toContain("docker inspect --format");
    expect(volumeCleanupCommand).toContain(
      "mount_inventory=$(findmnt -rn -o FSROOT,TARGET) || exit 76",
    );
    expect(volumeCleanupCommand).toContain(`printf '%s\n' "$mount_inventory" | awk`);
    expect(volumeCleanupCommand).toContain('index($0, root "/") == 1');
    expect(volumeCleanupCommand).toContain('index(root, $0 "/") == 1');
    expect(volumeCleanupCommand).toContain("rm -rf --one-file-system --");
    expect(volumeCleanupCommand).toContain(`test -L '${volumePath}'`);
    expect(volumeCleanupCommand).toContain(
      getExactRestoreStagingVolumeCleanupReceipt(replacementAttemptId, restoreAttemptId),
    );
    expect(volumeCleanupCommand.indexOf("docker container ls")).toBeLessThan(
      volumeCleanupCommand.indexOf("rm -rf"),
    );
    expect(volumeCleanupCommand).not.toContain(getVolumePath(agentId));
    expect(() =>
      buildExactRestoreStagingVolumeCleanupCommand(
        containerName,
        replacementAttemptId,
        `${volumePath}-wrong`,
      ),
    ).toThrow("differs from its container identity");
  });

  test("refuses descendant Docker binds and nested host mounts before staging deletion", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-restore-volume-cleanup-"));
    const bin = path.join(root, "bin");
    const relocatedData = path.join(root, "data");
    const agentId = "11111111-1111-4111-8111-111111111111";
    const restoreAttemptId = "22222222-2222-4222-8222-222222222222";
    const replacementAttemptId = "33333333-3333-4333-8333-333333333333";
    const containerName = `agent-restore-${agentId}-${restoreAttemptId}`;
    const productionVolume = `/data/agents/.restore/${agentId}/${restoreAttemptId}`;
    const volume = path.join(relocatedData, "agents", ".restore", agentId, restoreAttemptId);
    const attempts = path.join(root, "attempts");
    const attemptDirectory = path.join(attempts, replacementAttemptId);
    const rmMarker = path.join(root, "rm-invoked");
    const sentinel = path.join(volume, "must-survive");
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(volume, { recursive: true, mode: 0o700 });
    fs.mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(attemptDirectory, "cancelled"), "cancelled\n", { mode: 0o600 });
    fs.writeFileSync(sentinel, "durable-data", { mode: 0o600 });
    fs.writeFileSync(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(
      path.join(bin, "stat"),
      '#!/bin/sh\ncase "$2" in "%u") printf 0 ;; "%a") if test -d "$4"; then printf 700; else printf 600; fi ;; "%h") printf 1 ;; *) exit 64 ;; esac\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(bin, "docker"),
      '#!/bin/sh\ncase "$*" in *"--filter"*) exit 0 ;; "container ls -aq --no-trunc") if test -n "$ELIZA_TEST_DOCKER_MOUNT_SOURCE" || test -n "$ELIZA_TEST_DOCKER_CONTAINER_PRESENT"; then printf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi ;; inspect*) printf "%s\\n" "$ELIZA_TEST_DOCKER_MOUNT_SOURCE" ;; *) exit 64 ;; esac\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(bin, "findmnt"),
      '#!/bin/sh\nif test -n "$ELIZA_TEST_FINDMNT_FAILURE"; then exit 64; elif test -n "$ELIZA_TEST_HOST_MOUNT_SOURCE"; then printf "%s %s\\n" "$ELIZA_TEST_HOST_MOUNT_SOURCE" /outside-consumer; elif test -n "$ELIZA_TEST_HOST_MOUNT_TARGET"; then printf "%s %s\\n" / "$ELIZA_TEST_HOST_MOUNT_TARGET"; fi\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(bin, "rm"),
      '#!/bin/sh\nprintf invoked > "$ELIZA_TEST_RM_MARKER"\ncase "$*" in *"--one-file-system"*) if test -n "$ELIZA_TEST_RM_DELETE_VOLUME"; then /bin/rm -rf "$ELIZA_TEST_RM_DELETE_VOLUME"; fi ;; esac\nexit 0\n',
      { mode: 0o700 },
    );

    const command = buildExactRestoreStagingVolumeCleanupCommand(
      containerName,
      replacementAttemptId,
      productionVolume,
    )
      .replaceAll("/var/lib/eliza/replacement-attempts", attempts)
      .replaceAll("/data", relocatedData)
      .replaceAll("chmod 700 --", "chmod 700")
      .replaceAll("chmod 600 --", "chmod 600");
    const run = (env: NodeJS.ProcessEnv): Promise<number | null> =>
      new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], {
          env: {
            ...process.env,
            ...env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            ELIZA_TEST_RM_MARKER: rmMarker,
          },
        });
        child.on("close", resolve);
      });

    try {
      expect(await run({ ELIZA_TEST_DOCKER_MOUNT_SOURCE: `${volume}/eliza` })).toBe(76);
      expect(fs.existsSync(rmMarker)).toBe(false);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("durable-data");

      expect(await run({ ELIZA_TEST_DOCKER_MOUNT_SOURCE: path.dirname(volume) })).toBe(76);
      expect(fs.existsSync(rmMarker)).toBe(false);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("durable-data");

      expect(await run({ ELIZA_TEST_HOST_MOUNT_TARGET: `${volume}/nested-bind` })).toBe(76);
      expect(fs.existsSync(rmMarker)).toBe(false);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("durable-data");

      expect(await run({ ELIZA_TEST_HOST_MOUNT_SOURCE: `${volume}/eliza` })).toBe(76);
      expect(fs.existsSync(rmMarker)).toBe(false);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("durable-data");

      expect(await run({ ELIZA_TEST_FINDMNT_FAILURE: "1" })).toBe(76);
      expect(fs.existsSync(rmMarker)).toBe(false);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("durable-data");

      expect(
        await run({
          ELIZA_TEST_DOCKER_CONTAINER_PRESENT: "1",
          ELIZA_TEST_RM_DELETE_VOLUME: volume,
        }),
      ).toBe(0);
      expect(fs.existsSync(rmMarker)).toBe(true);
      expect(fs.existsSync(volume)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("distinguishes pre-effect, definitive, and ambiguous Docker-create failures", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-exact-fence-"));
    const bin = path.join(root, "bin");
    const volume = path.join(root, "volume");
    const attempts = path.join(root, "attempts");
    const agentId = "11111111-1111-4111-8111-111111111111";
    const containerName = getContainerName(agentId);
    const productionVolume = getVolumePath(agentId);
    const productionAttempts = "/var/lib/eliza/replacement-attempts";
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const marker = path.join(root, "docker-invoked");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(volume, { recursive: true });
    fs.writeFileSync(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "stat"),
      '#!/bin/sh\ncase "$2" in "%u") printf 0 ;; "%a") if test -d "$4"; then printf 700; else printf 600; fi ;; "%h") if test -n "$ELIZA_TEST_HARDLINK_PATH" && test "$4" = "$ELIZA_TEST_HARDLINK_PATH"; then printf 2; else printf 1; fi ;; "%d:%i") printf "1:1" ;; *) exit 64 ;; esac\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(volume, ".vault-passphrase"), "persisted-vault-value", {
      mode: 0o600,
    });

    const remap = (command: string) =>
      command
        .replaceAll(productionVolume, volume)
        .replaceAll(productionAttempts, attempts)
        // macOS test runners use BSD chmod/cat/mv, which do not all accept the
        // GNU `--` operand separator used on the Linux Docker nodes.
        .replaceAll("chmod 700 --", "chmod 700")
        .replaceAll("chmod 600 --", "chmod 600")
        .replaceAll("cat -- ", "cat ")
        .replaceAll("mv -- ", "mv ");
    const seedControlVaultSnapshot = (replacementAttemptId: string): void => {
      const attemptDirectory = path.join(attempts, replacementAttemptId);
      fs.mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(attemptDirectory, "vault-passphrase"), "persisted-vault-value", {
        mode: 0o600,
      });
    };
    const run = (
      command: string,
      input = "",
      extraPath?: string,
      extraEnv: NodeJS.ProcessEnv = {},
    ): Promise<{ code: number | null; output: string }> =>
      new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", remap(command)], {
          env: {
            ...process.env,
            ...extraEnv,
            PATH: `${extraPath ? `${extraPath}:` : ""}${bin}:${process.env.PATH}`,
          },
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk.toString()));
        child.stderr.on("data", (chunk) => (output += chunk.toString()));
        child.on("close", (code) => resolve({ code, output }));
        child.stdin.end(input);
      });

    try {
      const secretInput = buildDockerContainerEnvTransport({
        API_KEY: "one-shot-secret-sentinel",
      }).secretInput;

      const legacyAttemptId = "22222222-2222-4222-8222-222222222223";
      const legacyVaultPath = path.join(volume, ".vault-passphrase");
      const legacyArtifactPaths = [
        path.join(volume, `.container-env-${legacyAttemptId}`),
        path.join(volume, `.container-env-${legacyAttemptId}.body`),
        ...["stdin", "override", "generated", "normalized"].map(
          (kind) => `${legacyVaultPath}.${kind}.${legacyAttemptId}`,
        ),
      ];
      for (const artifactPath of legacyArtifactPaths) {
        fs.writeFileSync(artifactPath, "legacy-plaintext", { mode: 0o600 });
      }
      const legacyCleanup = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, legacyAttemptId),
      );
      expect(legacyCleanup).toEqual({
        code: 0,
        output: `${getReplacementSecretArtifactsCleanupReceipt(legacyAttemptId)}\n${getReplacementDockerCreateQuiescentReceipt(legacyAttemptId)}\n`,
      });
      for (const artifactPath of legacyArtifactPaths) {
        expect(fs.existsSync(artifactPath)).toBe(false);
      }

      const hardlinkAttemptId = "22222222-2222-4222-8222-222222222224";
      const hardlinkedLegacyEnv = path.join(volume, `.container-env-${hardlinkAttemptId}`);
      const retainedHardlink = path.join(root, "retained-legacy-env-hardlink");
      fs.writeFileSync(hardlinkedLegacyEnv, "hardlinked-plaintext", { mode: 0o600 });
      fs.linkSync(hardlinkedLegacyEnv, retainedHardlink);
      const hardlinkCleanup = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, hardlinkAttemptId),
        "",
        undefined,
        { ELIZA_TEST_HARDLINK_PATH: hardlinkedLegacyEnv },
      );
      expect(hardlinkCleanup.code).toBe(70);
      expect(hardlinkCleanup.output).not.toContain(
        getReplacementSecretArtifactsCleanupReceipt(hardlinkAttemptId),
      );
      expect(fs.readFileSync(hardlinkedLegacyEnv, "utf8")).toBe("hardlinked-plaintext");
      expect(fs.readFileSync(retainedHardlink, "utf8")).toBe("hardlinked-plaintext");

      const symlinkAttemptId = "99999999-9999-4999-8999-999999999999";
      const symlinkSecretPath = getReplacementControlSecretEnvPath(symlinkAttemptId);
      const symlinkAttemptDirectory = path.join(attempts, symlinkAttemptId);
      const externalEnvTarget = path.join(root, "external-env-target");
      const externalBodyTarget = path.join(root, "external-env-body-target");
      seedControlVaultSnapshot(symlinkAttemptId);
      fs.writeFileSync(externalEnvTarget, "external-env-must-not-change", { mode: 0o640 });
      fs.writeFileSync(externalBodyTarget, "external-body-must-not-change", { mode: 0o640 });
      fs.symlinkSync(externalEnvTarget, path.join(symlinkAttemptDirectory, "container-env"));
      fs.symlinkSync(externalBodyTarget, path.join(symlinkAttemptDirectory, "container-env.body"));
      const symlinkProducer = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: "true",
        secretEnvPath: symlinkSecretPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(symlinkAttemptId),
        exactReplacement: { containerName, replacementAttemptId: symlinkAttemptId },
      });
      expect(await run(symlinkProducer, secretInput)).toEqual({ code: 0, output: "" });
      expect(fs.readFileSync(externalEnvTarget, "utf8")).toBe("external-env-must-not-change");
      expect(fs.readFileSync(externalBodyTarget, "utf8")).toBe("external-body-must-not-change");
      expect(fs.statSync(externalEnvTarget).mode & 0o777).toBe(0o640);
      expect(fs.statSync(externalBodyTarget).mode & 0o777).toBe(0o640);
      expect(fs.existsSync(path.join(symlinkAttemptDirectory, "container-env"))).toBe(false);
      expect(fs.existsSync(path.join(symlinkAttemptDirectory, "container-env.body"))).toBe(false);

      const malformedAttemptId = "77777777-7777-4777-8777-777777777777";
      const malformedSecretPath = getReplacementControlSecretEnvPath(malformedAttemptId);
      seedControlVaultSnapshot(malformedAttemptId);
      const malformedProducer = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: `: > ${shellQuote(marker)}`,
        secretEnvPath: malformedSecretPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(malformedAttemptId),
        exactReplacement: { containerName, replacementAttemptId: malformedAttemptId },
      });
      const malformed = await run(malformedProducer, "API_KEY=truncated-without-sentinel\n");
      expect(malformed.code).not.toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(path.join(attempts, malformedAttemptId, "active"))).toBe(false);
      expect(fs.existsSync(path.join(attempts, malformedAttemptId, "container-env"))).toBe(false);
      const malformedCleanup = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, malformedAttemptId),
      );
      expect(malformedCleanup).toEqual({
        code: 0,
        output: `${getReplacementSecretArtifactsCleanupReceipt(malformedAttemptId)}\n${getReplacementDockerCreateQuiescentReceipt(malformedAttemptId)}\n`,
      });

      const definitiveAttemptId = "88888888-8888-4888-8888-888888888888";
      const definitiveSecretPath = getReplacementControlSecretEnvPath(definitiveAttemptId);
      seedControlVaultSnapshot(definitiveAttemptId);
      const definitiveProducer = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: `sh -c ${shellQuote(
          "printf '%s\\n' 'docker: Error response from daemon: Conflict. The container name is already in use by container' >&2; exit 125",
        )}`,
        secretEnvPath: definitiveSecretPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(definitiveAttemptId),
        exactReplacement: { containerName, replacementAttemptId: definitiveAttemptId },
      });
      const definitive = await run(definitiveProducer, secretInput);
      expect(definitive.code).toBe(125);
      expect(definitive.output).not.toContain("Conflict. The container name");
      expect(fs.existsSync(path.join(attempts, definitiveAttemptId, "active"))).toBe(false);
      expect(fs.existsSync(path.join(attempts, definitiveAttemptId, "docker-error"))).toBe(false);
      const definitiveCleanup = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, definitiveAttemptId),
      );
      expect(definitiveCleanup).toEqual({
        code: 0,
        output: `${getReplacementSecretArtifactsCleanupReceipt(definitiveAttemptId)}\n${getReplacementDockerCreateQuiescentReceipt(definitiveAttemptId)}\n`,
      });

      const secretEnvPath = getReplacementControlSecretEnvPath(attemptId);
      seedControlVaultSnapshot(attemptId);
      const failedProducer = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: "false",
        secretEnvPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(attemptId),
        exactReplacement: { containerName, replacementAttemptId: attemptId },
      });
      const failed = await run(failedProducer, secretInput);
      expect(failed.code).not.toBe(0);
      expect(failed.output).not.toContain("one-shot-secret-sentinel");
      expect(fs.existsSync(path.join(attempts, attemptId, "active"))).toBe(true);
      expect(fs.existsSync(path.join(attempts, attemptId, "container-env"))).toBe(false);

      const cleanup = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, attemptId),
      );
      expect(cleanup).toEqual({
        code: 0,
        output: `${getReplacementSecretArtifactsCleanupReceipt(attemptId)}\n`,
      });
      expect(fs.existsSync(path.join(attempts, attemptId, "active"))).toBe(true);
      const observedContainerId = "b".repeat(64);
      const observed = await run(
        buildReplacementCandidateObservedCommand(attemptId, observedContainerId),
      );
      expect(observed).toEqual({
        code: 0,
        output: `${getReplacementCandidateObservedReceipt(attemptId, observedContainerId)}\n`,
      });
      const cleanupWithObservation = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, attemptId),
      );
      expect(cleanupWithObservation).toEqual({
        code: 0,
        output: `${getReplacementSecretArtifactsCleanupReceipt(attemptId)}\n${getReplacementCandidateObservedReceipt(attemptId, observedContainerId)}\n`,
      });

      const replay = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: `: > ${shellQuote(marker)}`,
        secretEnvPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(attemptId),
        exactReplacement: { containerName, replacementAttemptId: attemptId },
      });
      const rejectedReplay = await run(replay, secretInput);
      expect(rejectedReplay.code).toBe(75);
      expect(rejectedReplay.output).not.toContain("one-shot-secret-sentinel");
      expect(fs.existsSync(marker)).toBe(false);

      const successfulAttemptId = "66666666-6666-4666-8666-666666666666";
      const successfulSecretPath = getReplacementControlSecretEnvPath(successfulAttemptId);
      seedControlVaultSnapshot(successfulAttemptId);
      const successfulProducer = buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: `printf '%s\\n' ${shellQuote("a".repeat(64))}`,
        secretEnvPath: successfulSecretPath,
        vaultPassphrasePath: getReplacementControlVaultPassphrasePath(successfulAttemptId),
        exactReplacement: {
          containerName,
          replacementAttemptId: successfulAttemptId,
        },
      });
      const succeeded = await run(successfulProducer, secretInput);
      expect(succeeded).toEqual({ code: 0, output: `${"a".repeat(64)}\n` });
      expect(fs.existsSync(path.join(attempts, successfulAttemptId, "active"))).toBe(false);
      const quiescentCleanup = await run(
        buildReplacementSecretArtifactsCleanupCommand(containerName, successfulAttemptId),
      );
      expect(quiescentCleanup).toEqual({
        code: 0,
        output: `${getReplacementSecretArtifactsCleanupReceipt(successfulAttemptId)}\n${getReplacementDockerCreateQuiescentReceipt(successfulAttemptId)}\n`,
      });

      for (const [suffix, kind] of [
        ["44444444-4444-4444-8444-444444444444", "file"],
        ["55555555-5555-4555-8555-555555555555", "symlink"],
      ] as const) {
        const attemptDirectory = path.join(attempts, suffix);
        fs.mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
        const survivingPath = path.join(attemptDirectory, "container-env");
        const externalTarget = path.join(root, `external-cleanup-target-${suffix}`);
        if (kind === "file") {
          fs.writeFileSync(survivingPath, "must-survive-fake-rm", { mode: 0o600 });
        } else {
          fs.writeFileSync(externalTarget, "external-target-must-survive", { mode: 0o640 });
          fs.symlinkSync(externalTarget, survivingPath);
        }
        const fakeRmBin = path.join(root, `fake-rm-${kind}`);
        fs.mkdirSync(fakeRmBin);
        fs.writeFileSync(path.join(fakeRmBin, "rm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const refused = await run(
          buildReplacementSecretArtifactsCleanupCommand(containerName, suffix),
          "",
          fakeRmBin,
        );
        expect(refused.code).toBe(70);
        expect(refused.output).not.toContain(getReplacementSecretArtifactsCleanupReceipt(suffix));
        if (kind === "symlink") {
          expect(fs.readFileSync(externalTarget, "utf8")).toBe("external-target-must-survive");
          expect(fs.statSync(externalTarget).mode & 0o777).toBe(0o640);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("derives exact cleanup paths from the canonical container name only", () => {
    const attemptId = "33333333-3333-4333-8333-333333333333";
    expect(() =>
      buildReplacementSecretArtifactsCleanupCommand("agent-not/a-valid-id", attemptId),
    ).toThrow();
    expect(() =>
      buildDockerCreateWithSecretEnvCommand({
        dockerCreateCommand: "docker create image:latest",
        secretEnvPath: "/data/agents/someone-else/.container-env-wrong",
        vaultPassphrasePath: "/data/agents/someone-else/.vault-passphrase",
        exactReplacement: {
          containerName: "agent-11111111-1111-4111-8111-111111111111",
          replacementAttemptId: attemptId,
        },
      }),
    ).toThrow("not canonical");
  });
});

describe("validateVolumePath", () => {
  test("requires absolute, normalized, traversal-free paths", () => {
    expect(() => validateVolumePath("/data/agents/x")).not.toThrow();
    expect(() => validateVolumePath("relative/path")).toThrow();
    expect(() => validateVolumePath("/")).toThrow();
    expect(() => validateVolumePath("/data/../etc")).toThrow(/normalized/);
    expect(() => validateVolumePath("/data//x")).toThrow(/normalized/);
    expect(() => validateVolumePath("/data/x/")).toThrow(/normalized/);
  });
});

describe("getContainerName / getVolumePath", () => {
  test("derive deterministic, validated names from agent id", () => {
    expect(getContainerName("abc123")).toBe("agent-abc123");
    expect(getVolumePath("abc123")).toBe("/data/agents/abc123");
    expect(() => getContainerName("bad;id")).toThrow();
  });
});

describe("architecture inference", () => {
  test("normalizes arch aliases", () => {
    expect(normalizeDockerArchitecture("x86_64")).toBe("amd64");
    expect(normalizeDockerArchitecture("aarch64")).toBe("arm64");
    expect(normalizeDockerArchitecture("mips")).toBeNull();
    expect(normalizeDockerArchitecture(null)).toBeNull();
  });

  test("Hetzner CAX → arm64, CX/CPX/CCX → amd64", () => {
    expect(inferArchitectureFromHetznerServerType("cax21")).toBe("arm64");
    expect(inferArchitectureFromHetznerServerType("cpx31")).toBe("amd64");
    expect(inferArchitectureFromHetznerServerType("unknown")).toBeNull();
  });

  test("platform requirement + compatibility", () => {
    expect(requiredArchitectureForPlatform("linux/arm64")).toBe("arm64");
    expect(isArchitectureCompatibleWithPlatform("amd64", "linux/amd64")).toBe(true);
    expect(isArchitectureCompatibleWithPlatform("amd64", "linux/arm64")).toBe(false);
    // unknown arch or platform is treated as compatible (no false negatives).
    expect(isArchitectureCompatibleWithPlatform(null, "linux/arm64")).toBe(true);
  });
});

describe("dockerPlatformFlag", () => {
  test("empty → no flag, valid → quoted flag, invalid → throws", () => {
    expect(dockerPlatformFlag(undefined)).toEqual([]);
    expect(dockerPlatformFlag("linux/amd64")).toEqual(["--platform 'linux/amd64'"]);
    expect(() => dockerPlatformFlag("linux/amd64; evil")).toThrow(/Invalid Docker platform/);
  });
});

describe("extractDockerCreateContainerId", () => {
  test("picks the hex id line, ignores warnings, truncates to 12", () => {
    const out = "WARNING: something\n" + "a".repeat(64);
    expect(extractDockerCreateContainerId(out)).toBe("aaaaaaaaaaaa");
    expect(() => extractDockerCreateContainerId("no id here")).toThrow(/invalid container id/);
  });
  test("paid admission retains all 64 identity characters and rejects abbreviated ids", () => {
    const id = "a".repeat(64);
    expect(extractDockerCreateContainerId(`WARNING: pull\n${id}`, { requireFullId: true })).toBe(
      id,
    );
    expect(() => extractDockerCreateContainerId(id.slice(0, 12), { requireFullId: true })).toThrow(
      "full immutable Docker id",
    );
  });
});

describe("steward url + host gateway routing", () => {
  test("loopback host rewrites to host.docker.internal, override wins", () => {
    expect(resolveStewardContainerUrl("http://localhost:8787/steward")).toBe(
      "http://host.docker.internal:8787/steward",
    );
    expect(resolveStewardContainerUrl("https://api.example.com/steward")).toBe(
      "https://api.example.com/steward",
    );
    expect(resolveStewardContainerUrl("http://localhost/x", "http://override/")).toBe(
      "http://override",
    );
    expect(() => resolveStewardContainerUrl("not a url")).toThrow(/Invalid STEWARD_API_URL/);
  });

  test("requiresDockerHostGateway only for host.docker.internal", () => {
    expect(requiresDockerHostGateway("http://host.docker.internal:1/x")).toBe(true);
    expect(requiresDockerHostGateway("http://example.com")).toBe(false);
    expect(requiresDockerHostGateway("garbage")).toBe(false);
  });
});

describe("port + metadata helpers", () => {
  test("allocatePort stays in range and avoids the exclusion set", () => {
    const excluded = new Set([5000, 5001, 5002]);
    for (let i = 0; i < 20; i++) {
      const port = allocatePort(5000, 5010, excluded);
      expect(port).toBeGreaterThanOrEqual(5000);
      expect(port).toBeLessThan(5010);
      expect(excluded.has(port)).toBe(false);
    }
    // fully exhausted range throws rather than looping forever.
    const full = new Set([5000, 5001]);
    expect(() => allocatePort(5000, 5002, full)).toThrow(/No available ports/);
  });

  test("readDockerHostPortFromMetadata returns positive ints only", () => {
    expect(readDockerHostPortFromMetadata({ hostPort: 8080 })).toBe(8080);
    expect(readDockerHostPortFromMetadata({ hostPort: -1 })).toBeNull();
    expect(readDockerHostPortFromMetadata({ hostPort: "80" })).toBeNull();
    expect(readDockerHostPortFromMetadata(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Container labels (test-vs-user marking)
// ---------------------------------------------------------------------------

describe("agent container labels", () => {
  const POOL_ORG = "00000000-0000-4000-8000-000000077001";
  const TEST_ORG = "11111111-1111-4111-8111-111111111111";
  const USER_ORG = "22222222-2222-4222-8222-222222222222";

  test("resolveAgentContainerClass distinguishes user / pool / test", () => {
    const options = { warmPoolOrgId: POOL_ORG, testOrgIds: [TEST_ORG] };
    expect(resolveAgentContainerClass(USER_ORG, options)).toBe("user");
    expect(resolveAgentContainerClass(POOL_ORG, options)).toBe("pool");
    expect(resolveAgentContainerClass(TEST_ORG, options)).toBe("test");
  });

  test("unknown orgs default to user — the safe direction for cleanup tooling", () => {
    expect(
      resolveAgentContainerClass("unknown-org", { warmPoolOrgId: POOL_ORG, testOrgIds: [] }),
    ).toBe("user");
  });

  test("buildAgentContainerLabelArgs emits the full marking set", () => {
    const args = buildAgentContainerLabelArgs({
      agentId: "agent-123",
      organizationId: USER_ORG,
      containerClass: "user",
    });
    expect(args).toEqual([
      ["ai.elizaos.managed-by", "eliza-cloud"],
      ["ai.elizaos.agent-id", "agent-123"],
      ["ai.elizaos.org-id", USER_ORG],
      ["ai.elizaos.container-class", "user"],
    ]);
  });

  test("buildAgentContainerLabelFlags shell-quotes each --label", () => {
    const flags = buildAgentContainerLabelFlags({
      agentId: "abc",
      organizationId: "org'; rm -rf /",
      containerClass: "test",
    });
    expect(flags).toHaveLength(4);
    expect(flags[0]).toBe("--label 'ai.elizaos.managed-by=eliza-cloud'");
    // Embedded single quote must be escaped, not break out of the quoting.
    expect(flags[2]).toContain(`'"'"'`);
    expect(flags[3]).toBe("--label 'ai.elizaos.container-class=test'");
  });
});

describe("resolveVpnTeardown (#16565)", () => {
  test("a registered id always wins — the only unambiguous deletion handle", () => {
    expect(resolveVpnTeardown({ vpnNodeId: "blue-3", previousVpnNodeId: "old-7" })).toEqual({
      kind: "by-id",
      nodeId: "blue-3",
    });
    expect(resolveVpnTeardown({ vpnNodeId: "blue-3" })).toEqual({
      kind: "by-id",
      nodeId: "blue-3",
    });
  });

  test("preserve mode with no registered id forbids by-name deletion — the same-name node is the LIVE one", () => {
    // The review-blocking hole: container-start failure or required-registration
    // timeout while the old node is preserved must never resolve to by-name.
    expect(resolveVpnTeardown({ previousVpnNodeId: "old-7" })).toEqual({
      kind: "skip-preserved",
    });
  });

  test("plain provisions without an id keep the historical by-name cleanup", () => {
    expect(resolveVpnTeardown({})).toEqual({ kind: "by-name" });
  });
});

describe("volume-persisted vault passphrase (#18080 / #19225 / #22060)", () => {
  test("keeps the exported V1 framing labels stable for byte-native producers", () => {
    expect(VOLUME_VAULT_STDIN_FRAME_VERSION).toBe("ELIZA_VAULT_STDIN_V1");
    expect(VOLUME_VAULT_STDIN_FRAME_END).toBe("ELIZA_VAULT_STDIN_V1_END");
  });

  test("places the fenced publication candidate on the durable key filesystem", () => {
    const volume = "/data/agents/11111111-1111-4111-8111-111111111111";
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const keyPath = getVolumeVaultPassphrasePath(volume);
    const candidatePath = `${keyPath}.candidate.${attemptId}`;
    const command = buildVolumeVaultPassphraseCommand(volume, 0, attemptId);
    const cleanupCommand = buildReplacementSecretArtifactsCleanupCommand(
      getContainerName("11111111-1111-4111-8111-111111111111"),
      attemptId,
    );

    expect(command).toContain(
      `generated_file='/var/lib/eliza/replacement-attempts/${attemptId}/vault-generated'`,
    );
    expect(command).toContain(`key_candidate_file='${candidatePath}'`);
    expect(command).toContain('if exec 8>"$key_candidate_file"');
    expect(command).toContain("secure_private_regular_fd_proof 8");
    expect(command).toContain('ln "$key_candidate_file" "$key_file"');
    expect(command).not.toContain('ln "$generated_file" "$key_file"');
    expect(cleanupCommand).toContain(candidatePath);
  });

  test.skipIf(process.platform !== "linux")(
    "publishes a fenced key when control and target paths are on distinct filesystems",
    async () => {
      const { spawn } = await import("node:child_process");
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const targetFilesystemRoot = ["/dev/shm", "/run/shm"].find((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.W_OK);
          return fs.statSync(candidate).dev !== fs.statSync(os.tmpdir()).dev;
        } catch {
          return false;
        }
      });
      if (!targetFilesystemRoot) return;

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-crossfs-control-"));
      const volume = fs.mkdtempSync(path.join(targetFilesystemRoot, "eliza-crossfs-volume-"));
      const bin = path.join(root, "bin");
      const attempts = path.join(root, "attempts");
      const productionVolume = "/data/agents/11111111-1111-4111-8111-111111111111";
      const productionAttempts = "/var/lib/eliza/replacement-attempts";
      const attemptId = "33333333-3333-4333-8333-333333333333";
      const override = "cross-filesystem-vault-secret";
      fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      fs.writeFileSync(
        path.join(bin, "stat"),
        '#!/bin/sh\ncase "$2" in "%u") printf 0 ;; "%a") if test -d "$4"; then printf 700; else printf 600; fi ;; "%h") printf 1 ;; "%d:%i") printf "1:1" ;; "%d:%i:%s:%y:%z") printf stable-fingerprint ;; *) exit 64 ;; esac\n',
        { mode: 0o700 },
      );

      try {
        expect(fs.statSync(root).dev).not.toBe(fs.statSync(volume).dev);
        const command = buildVolumeVaultPassphraseCommand(
          productionVolume,
          Buffer.byteLength(override),
          attemptId,
        )
          .replaceAll(productionVolume, volume)
          .replaceAll(productionAttempts, attempts);
        const frame = `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${Buffer.byteLength(override)}\n${override}\n${VOLUME_VAULT_STDIN_FRAME_END}\n`;
        const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
          const child = spawn("/bin/sh", ["-c", command], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
          });
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk.toString()));
          child.stderr.on("data", (chunk) => (output += chunk.toString()));
          child.on("close", (code) => resolve({ code, output }));
          child.stdin.end(frame);
        });

        expect(result).toEqual({ code: 0, output: "" });
        expect(fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf8")).toBe(override);
        expect(fs.readdirSync(volume)).toEqual([".vault-passphrase"]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(volume, { recursive: true, force: true });
      }
    },
  );

  test("exact vault staging replaces control symlinks and rejects a durable-key symlink", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-exact-vault-symlink-"));
    const bin = path.join(root, "bin");
    const volume = path.join(root, "volume");
    const attempts = path.join(root, "attempts");
    const productionVolume = "/data/agents/11111111-1111-4111-8111-111111111111";
    const productionAttempts = "/var/lib/eliza/replacement-attempts";
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(volume, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(
      path.join(bin, "stat"),
      '#!/bin/sh\ncase "$2" in "%u") printf 0 ;; "%a") if test -d "$4"; then printf 700; else printf 600; fi ;; "%h") printf 1 ;; "%d:%i") printf "1:1" ;; "%d:%i:%s:%y:%z") printf stable-fingerprint ;; *) exit 64 ;; esac\n',
      { mode: 0o700 },
    );
    const remap = (command: string): string =>
      command
        .replaceAll(productionVolume, volume)
        .replaceAll(productionAttempts, attempts)
        .replaceAll("chmod 700 --", "chmod 700")
        .replaceAll("chmod 600 --", "chmod 600")
        .replaceAll("mv -- ", "mv ");
    const run = (
      command: string,
      input: string,
    ): Promise<{ code: number | null; output: string }> =>
      new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", remap(command)], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk.toString()));
        child.stderr.on("data", (chunk) => (output += chunk.toString()));
        child.on("close", (code) => resolve({ code, output }));
        child.stdin.end(input);
      });
    const frame = (override: string): string =>
      `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${Buffer.byteLength(override)}\n${override}\n${VOLUME_VAULT_STDIN_FRAME_END}\n`;

    try {
      const attemptId = "33333333-3333-4333-8333-333333333333";
      const attemptDirectory = path.join(attempts, attemptId);
      const externalTarget = path.join(root, "external-transient-target");
      const override = "exact-vault-secret-value";
      fs.mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(externalTarget, "external-transient-must-not-change", { mode: 0o640 });
      for (const name of [
        "vault-stdin",
        "vault-override",
        "vault-generated",
        "vault-normalized",
        "vault-passphrase",
      ]) {
        fs.symlinkSync(externalTarget, path.join(attemptDirectory, name));
      }
      const command = buildVolumeVaultPassphraseCommand(
        productionVolume,
        Buffer.byteLength(override),
        attemptId,
      );
      const seeded = await run(command, frame(override));
      expect(seeded).toEqual({ code: 0, output: "" });
      expect(fs.readFileSync(externalTarget, "utf8")).toBe("external-transient-must-not-change");
      expect(fs.statSync(externalTarget).mode & 0o777).toBe(0o640);
      expect(fs.readFileSync(path.join(volume, ".vault-passphrase"), "utf8")).toBe(override);
      expect(fs.readFileSync(path.join(attemptDirectory, "vault-passphrase"), "utf8")).toBe(
        override,
      );

      const rejectedAttemptId = "44444444-4444-4444-8444-444444444444";
      const externalKeyTarget = path.join(root, "external-durable-key-target");
      fs.writeFileSync(externalKeyTarget, "external-key-must-not-change", { mode: 0o640 });
      fs.unlinkSync(path.join(volume, ".vault-passphrase"));
      fs.symlinkSync(externalKeyTarget, path.join(volume, ".vault-passphrase"));
      const rejected = await run(
        buildVolumeVaultPassphraseCommand(productionVolume, 0, rejectedAttemptId),
        frame(""),
      );
      expect(rejected.code).toBe(70);
      expect(rejected.output).not.toContain("external-key-must-not-change");
      expect(fs.readFileSync(externalKeyTarget, "utf8")).toBe("external-key-must-not-change");
      expect(fs.statSync(externalKeyTarget).mode & 0o777).toBe(0o640);
      expect(fs.existsSync(path.join(attempts, rejectedAttemptId, "vault-passphrase"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The real-process cases run the exact shell program sent over SSH against
  // local /bin/sh and a temp agent volume. They cover shell mutation and trap
  // behavior, but not SSH channel or supported-node behavior.
  const shExecStdin = async (cmd: string, input: string, _timeoutMs: number): Promise<string> => {
    const { spawn } = await import("node:child_process");
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", cmd]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(Object.assign(new Error(stderr || `shell exited ${code}`), { code }));
      });
      child.stdin.end(input);
    });
  };

  async function makeVolume(): Promise<string> {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    return fs.mkdtempSync(path.join(os.tmpdir(), "eliza-agent-volume-"));
  }

  test("fails exact vault setup when temporary-secret cleanup is unresolved", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    const override = "cleanup-vault-secret-sentinel";
    const failingCleanupExec: typeof shExecStdin = (command, input, timeoutMs) =>
      shExecStdin(`rm() { return 1; }; ${command}`, input, timeoutMs);

    try {
      const error = await ensureVolumeVaultPassphrase(
        failingCleanupExec,
        volume,
        5_000,
        override,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 70 });
      expect(String(error)).not.toContain(override);
      const temporaryFiles = fs
        .readdirSync(volume)
        .filter((name) => name.startsWith(".vault-passphrase."));
      expect(temporaryFiles).toEqual([]);
    } finally {
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  test("SSH setup failure preserves the transport error without exposing the override", async () => {
    const volume = await makeVolume();
    const override = "operator-secret-value";
    let command = "";
    let input = "";
    const failedExec = async (cmd: string, stdin: string): Promise<string> => {
      command = cmd;
      input = stdin;
      throw new Error("ssh transport unavailable");
    };
    await expect(ensureVolumeVaultPassphrase(failedExec, volume, 5_000, override)).rejects.toThrow(
      "ssh transport unavailable",
    );
    expect(command).not.toContain(override);
    expect(command).not.toContain("ELIZA_VAULT_PASSPHRASE");
    expect(input).toContain(override);
    expect(input).toMatch(/^ELIZA_VAULT_STDIN_V1 \d+\n/);
    expect(input).toEndWith("\nELIZA_VAULT_STDIN_V1_END\n");
    expect("ssh transport unavailable").not.toContain(override);
    const fs = await import("node:fs");
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("container A creates a 64-hex key file with 0600 on the volume", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000);
    const key = fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const keyPath = getVolumeVaultPassphrasePath(volume);
    expect(fs.readFileSync(keyPath, "utf-8")).toBe(key);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("rejects malformed framed stdin before first-provision mutation", async () => {
    const fs = await import("node:fs");
    for (const override of [undefined, "operator-secret-value"] as const) {
      const volume = await makeVolume();
      let command = "";
      let validFrame = "";
      await ensureVolumeVaultPassphrase(
        async (cmd, input) => {
          command = cmd;
          validFrame = input;
          return "";
        },
        volume,
        5_000,
        override,
      );
      const terminator = validFrame.split("\n").at(-2);
      expect(terminator).toBe("ELIZA_VAULT_STDIN_V1_END");
      const malformedFrames = [
        validFrame.slice(0, -1),
        `${validFrame}x`,
        `${validFrame}${terminator}\n`,
      ];

      for (const malformedFrame of malformedFrames) {
        await expect(shExecStdin(command, malformedFrame, 5_000)).rejects.toMatchObject({
          code: 44,
        });
        expect(fs.readdirSync(volume)).toEqual([]);
      }
      expect(command).not.toContain(override ?? "operator-secret-value");
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  test("signal interruption during frame upload removes staged secret bytes", async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const volume = await makeVolume();
    const override = "interrupted-operator-secret";
    let command = "";
    let validFrame = "";
    await ensureVolumeVaultPassphrase(
      async (cmd, input) => {
        command = cmd;
        validFrame = input;
        return "";
      },
      volume,
      5_000,
      override,
    );

    const child = spawn("/bin/sh", ["-c", command], { detached: true });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.stdin.write(validFrame.slice(0, -8));
    for (
      let attempt = 0;
      attempt < 100 && !fs.readdirSync(volume).some((entry) => entry.includes(".stdin."));
      attempt++
    ) {
      await Bun.sleep(10);
    }
    expect(fs.readdirSync(volume).some((entry) => entry.includes(".stdin."))).toBe(true);

    process.kill(-child.pid!, "SIGTERM");
    await closed;
    expect(output).not.toContain(override);
    expect(fs.readdirSync(volume)).toEqual([]);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("maps an invalid frame to a non-secret typed boundary error", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    const override = "operator-secret-value";
    let failure: unknown;
    try {
      await ensureVolumeVaultPassphrase(
        async () => {
          throw Object.assign(new Error("shell exited 44"), { code: 44 });
        },
        volume,
        5_000,
        override,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "SANDBOX_VAULT_PASSPHRASE_STDIN_INCOMPLETE",
      context: { volumePath: volume },
    });
    expect(String(failure)).not.toContain(override);
    expect(JSON.stringify((failure as { context?: unknown }).context)).not.toContain(override);
    expect(fs.readdirSync(volume)).toEqual([]);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("frames a multibyte override by byte length and rejects truncation", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    const override = "operator-🔐-密钥-value";
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, override);
    const keyPath = getVolumeVaultPassphrasePath(volume);
    expect(fs.readFileSync(keyPath, "utf-8")).toBe(override);

    await expect(
      ensureVolumeVaultPassphrase(
        async (command, input, timeoutMs) => shExecStdin(command, input.slice(0, -1), timeoutMs),
        volume,
        5_000,
        override,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_VAULT_PASSPHRASE_STDIN_INCOMPLETE" });
    expect(fs.readFileSync(keyPath, "utf-8")).toBe(override);
    expect(fs.readdirSync(volume)).toEqual([".vault-passphrase"]);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("rejects malformed framed stdin before inspecting an existing volume", async () => {
    const fs = await import("node:fs");
    for (const override of [undefined, "operator-secret-value"] as const) {
      const volume = await makeVolume();
      await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, override);
      const keyPath = getVolumeVaultPassphrasePath(volume);
      const persisted = fs.readFileSync(keyPath);
      const mode = fs.statSync(keyPath).mode & 0o777;
      let command = "";
      let validFrame = "";
      await ensureVolumeVaultPassphrase(
        async (cmd, input) => {
          command = cmd;
          validFrame = input;
          return "";
        },
        volume,
        5_000,
        override,
      );
      const terminator = validFrame.split("\n").at(-2);
      expect(terminator).toBe("ELIZA_VAULT_STDIN_V1_END");
      const malformedFrames = [
        validFrame.slice(0, -1),
        `${validFrame}x`,
        `${validFrame}${terminator}\n`,
      ];

      for (const malformedFrame of malformedFrames) {
        await expect(shExecStdin(command, malformedFrame, 5_000)).rejects.toMatchObject({
          code: 44,
        });
        expect(fs.readFileSync(keyPath)).toEqual(persisted);
        expect(fs.statSync(keyPath).mode & 0o777).toBe(mode);
        expect(fs.readdirSync(volume)).toEqual([".vault-passphrase"]);
      }
      expect(command).not.toContain(override ?? "operator-secret-value");
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  test("replacement container B over the same volume derives the SAME key from a newly constructed env", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    // Two independent provisions (A then its replacement B): each runs the
    // read-or-create against the shared agent volume, nothing is copied from
    // A's environment.
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000);
    const keyA = fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8");
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000);
    const keyB = fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8");
    expect(keyB).toBe(keyA);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("distinct agent volumes get distinct random keys — never derived from an identifier", async () => {
    const fs = await import("node:fs");
    const volumeA = await makeVolume();
    const volumeB = await makeVolume();
    await ensureVolumeVaultPassphrase(shExecStdin, volumeA, 5_000);
    await ensureVolumeVaultPassphrase(shExecStdin, volumeB, 5_000);
    const keyA = fs.readFileSync(getVolumeVaultPassphrasePath(volumeA), "utf-8");
    const keyB = fs.readFileSync(getVolumeVaultPassphrasePath(volumeB), "utf-8");
    expect(keyA).not.toBe(keyB);
    fs.rmSync(volumeA, { recursive: true, force: true });
    fs.rmSync(volumeB, { recursive: true, force: true });
  });

  test("an operator-provisioned key file is honored as-is", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    fs.writeFileSync(getVolumeVaultPassphrasePath(volume), "operator-supplied-passphrase\n");
    await expect(ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000)).resolves.toBeUndefined();
    expect(fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8")).toBe(
      "operator-supplied-passphrase",
    );
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("A with operator override, replacement B without it: B derives A's key from the volume", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    // Launch A injects ELIZA_VAULT_PASSPHRASE; the override must seed the
    // persisted key file instead of bypassing the volume lifecycle.
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "dummy-operator-key-A");
    const keyPath = getVolumeVaultPassphrasePath(volume);
    expect(fs.readFileSync(keyPath, "utf-8")).toBe("dummy-operator-key-A");
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    // Replacement B is launched over the same volume with NO override — the
    // regression: it must read A's key, not mint a fresh local fallback.
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000);
    expect(fs.readFileSync(keyPath, "utf-8")).toBe("dummy-operator-key-A");
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("relaunching with the same override over the seeded volume is idempotent", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "dummy-operator-key-A");
    await expect(
      ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "dummy-operator-key-A"),
    ).resolves.toBeUndefined();
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("fails closed when the override conflicts with an already-persisted key", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    // The volume already has a durable key (e.g. generated by a prior
    // no-override launch); a different injected override must not silently
    // win OR silently lose — either guess can orphan ciphertext.
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000);
    const persisted = fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8");
    await expect(
      ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "dummy-other-override"),
    ).rejects.toThrow(/durable source of truth/);
    // The persisted key survives the refusal untouched.
    expect(fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8")).toBe(persisted);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("concurrent first provisions establish exactly one durable override", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    const overrides = ["concurrent-operator-key-A", "concurrent-operator-key-B"];
    const results = await Promise.allSettled(
      overrides.map((override) =>
        ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, override),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(String(rejected.reason)).toMatch(/durable source of truth/);
    }
    expect(overrides).toContain(fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8"));
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("fails closed on an unusable override BEFORE seeding the key file", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    await expect(ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "short")).rejects.toThrow(
      /refusing to seed/,
    );
    // Nothing was written — the next launch can still establish a good key.
    expect(fs.existsSync(getVolumeVaultPassphrasePath(volume))).toBe(false);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("rejects raw control bytes before remote mutation and permits later recovery", async () => {
    const fs = await import("node:fs");
    const invalidOverrides = [
      "operator-key\0suffix",
      "operator-key\x7fsuffix",
      "operator-key\nsuffix",
      "operator-key\rsuffix",
      "operator-key\tsuffix",
      "operator-key\x01suffix",
    ];

    for (const invalidOverride of invalidOverrides) {
      const volume = await makeVolume();
      let remoteCalls = 0;
      const trackedExec: typeof shExecStdin = async (...args) => {
        remoteCalls += 1;
        return shExecStdin(...args);
      };

      await expect(
        ensureVolumeVaultPassphrase(trackedExec, volume, 5_000, invalidOverride),
      ).rejects.toThrow(/refusing to seed/);
      expect(remoteCalls).toBe(0);
      expect(fs.readdirSync(volume)).toEqual([]);

      await expect(
        ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "valid-operator-key"),
      ).resolves.toBeUndefined();
      expect(fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8")).toBe(
        "valid-operator-key",
      );
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  test("an empty or whitespace-only override falls through to the volume lifecycle", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    await ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000, "  ");
    const key = fs.readFileSync(getVolumeVaultPassphrasePath(volume), "utf-8");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("fails closed on an unusable persisted key instead of minting a fresh per-launch key", async () => {
    const fs = await import("node:fs");
    const volume = await makeVolume();
    fs.writeFileSync(getVolumeVaultPassphrasePath(volume), "short\n");
    await expect(ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000)).rejects.toThrow(
      /refusing to mint a fresh per-launch key/,
    );
    fs.rmSync(volume, { recursive: true, force: true });
  });

  test("fails closed without rewriting persisted keys containing control bytes", async () => {
    const fs = await import("node:fs");
    for (const controlByte of [0x00, 0x7f, 0x0a, 0x0d, 0x09, 0x01]) {
      const volume = await makeVolume();
      const keyPath = getVolumeVaultPassphrasePath(volume);
      const corruptKey = Buffer.concat([
        Buffer.from("operator-key"),
        Buffer.from([controlByte]),
        Buffer.from("suffix"),
      ]);
      fs.writeFileSync(keyPath, corruptKey);

      await expect(ensureVolumeVaultPassphrase(shExecStdin, volume, 5_000)).rejects.toThrow(
        /persisted vault passphrase.*unusable/,
      );
      expect(fs.readFileSync(keyPath)).toEqual(corruptKey);
      expect(fs.readdirSync(volume)).toEqual([".vault-passphrase"]);
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  test("the durable state root lands on the /root/.eliza mount", () => {
    expect(CONTAINER_DURABLE_STATE_DIR).toBe("/root/.eliza");
  });
});
