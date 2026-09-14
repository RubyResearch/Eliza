/**
 * Tests for the agent-backup service: snapshot capture + restore and the
 * KMS-encrypted local backup envelope. Exercised against a real tmpdir
 * filesystem, a real in-memory KMS backend, and the real PGlite `dumpDataDir`
 * path via a stub adapter — deterministic, no network.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AgentBackupStateData,
  AgentSnapshotBudgetExceededError,
  createAgentSnapshot,
  createLocalAgentBackup,
  fetchAgentScopedRowsBatched,
  listLocalAgentBackups,
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
  purgeAdmittedRetiredLocalAgentBackups,
  restoreAgentSnapshot,
  restoreLocalAgentBackup,
  reviewRetiredLocalAgentBackups,
  SnapshotBudget,
} from "./agent-backup.ts";
import { withAgentBackupAuthority } from "./agent-backup-authority.ts";
import { AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS } from "./agent-backup-v2-capture.ts";

const ORIGINAL_ENV = {
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
  ELIZA_KMS_BACKEND: process.env.ELIZA_KMS_BACKEND,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
  POSTGRES_URL: process.env.POSTGRES_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function runtimeStub(agentId: string): AgentRuntime {
  return {
    agentId,
    character: { name: "Backup Test Agent" },
    adapter: {
      close: async () => undefined,
    },
    getSetting: () => null,
  } as unknown as AgentRuntime;
}

function boundedPgliteAdapter(
  dataDir: string,
  createDump: () => unknown | Promise<unknown>,
  release: () => void = () => undefined,
) {
  return {
    close: async () => undefined,
    getPgliteDataDir: () => dataDir,
    dumpPgliteDataDirAfterPreflight: async <T>(preflight: () => Promise<T>) => {
      const proof = await preflight();
      return { dump: await createDump(), preflight: proof, release };
    },
  };
}

async function writeFixtureState(
  root: string,
  pgliteDir: string,
): Promise<void> {
  await fs.mkdir(path.join(root, "media"), { recursive: true });
  await fs.mkdir(path.join(root, ".vault-pglite"), { recursive: true });
  await fs.mkdir(path.join(root, "audit"), { recursive: true });
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  await fs.mkdir(pgliteDir, { recursive: true });

  await fs.writeFile(path.join(root, "eliza.json"), '{"name":"fixture"}\n');
  await fs.writeFile(
    path.join(root, "media", `${"a".repeat(64)}.txt`),
    "media-bytes",
  );
  await fs.writeFile(
    path.join(root, "vault.json"),
    '{"version":1,"entries":{}}\n',
    {
      mode: 0o600,
    },
  );
  await fs.writeFile(
    path.join(root, ".vault-pglite", "data.bin"),
    "ciphertext-ish",
  );
  await fs.writeFile(
    path.join(root, "audit", "vault.jsonl"),
    '{"event":"unlock"}\n',
  );
  await fs.writeFile(
    path.join(root, "skills", "active.json"),
    '{"skills":[]}\n',
  );
  await fs.mkdir(path.join(root, "skills", ".cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, "skills", ".cache", "catalog.json"),
    "downloadable catalog",
  );
  await fs.writeFile(
    path.join(root, "skills", ".cache", "lock.json"),
    '{"installed":"pinned"}',
  );
  // Re-downloadable model weights / caches must never enter stateFiles (#17920).
  await fs.mkdir(path.join(root, "models"), { recursive: true });
  await fs.writeFile(
    path.join(root, "models", "openai.json"),
    '{"models":[]}\n',
  );
  await fs.mkdir(path.join(root, "models", "weights"), { recursive: true });
  await fs.writeFile(
    path.join(root, "models", "weights", "giant.bin"),
    "x".repeat(1024),
  );
  await fs.mkdir(path.join(root, "tool-cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tool-cache", "web-search.bin"),
    "cached-tool-result",
  );
  await fs.mkdir(path.join(root, "cache"), { recursive: true });
  await fs.writeFile(path.join(root, "cache", "runtime.tmp"), "volatile-cache");
  await fs.writeFile(path.join(pgliteDir, "pgdata.bin"), "database-bytes");
  await fs.writeFile(
    path.join(pgliteDir, "postmaster.pid"),
    `${process.pid}\n`,
  );
  await fs.writeFile(path.join(pgliteDir, "postmaster.opts"), "runtime opts");
  await fs.writeFile(
    path.join(pgliteDir, "eliza-pglite.lock"),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
  );
  await fs.mkdir(path.join(pgliteDir, "pg_stat_tmp"), { recursive: true });
  await fs.writeFile(
    path.join(pgliteDir, "pg_stat_tmp", "stats.tmp"),
    "runtime stats",
  );
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

beforeEach(() => {
  vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 * 1024);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});

describe("agent backup manifest", () => {
  test("retired snapshots cannot resurrect files, while a current snapshot preserves the durable boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-retirement-"));
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    try {
      await writeFixtureState(root, pgliteDir);
      const runtime = runtimeStub("11111111-1111-4111-8111-111111111111");
      const old = await createAgentSnapshot(runtime, {} as never);
      const legacy = structuredClone(old);
      delete legacy.manifest.restoreGeneration;
      const generation = await withAgentBackupAuthority(root, (authority) =>
        authority.retire(runtime.agentId, "family-delete-1"),
      );
      await expect(
        createAgentSnapshot(runtime, {} as never),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETIREMENT_PENDING" });
      await expect(restoreAgentSnapshot(runtime, old)).rejects.toMatchObject({
        code: "AGENT_BACKUP_RETIREMENT_PENDING",
      });
      await withAgentBackupAuthority(root, async (authority) => {
        expect(await authority.pendingRetirement(runtime.agentId)).toEqual({
          operationId: "family-delete-1",
          generation,
        });
        expect(await authority.retire(runtime.agentId, "family-delete-1")).toBe(
          generation,
        );
        await expect(
          authority.retire(runtime.agentId, "another-delete"),
        ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETIREMENT_PENDING" });
        await expect(
          authority.completeRetirement(
            runtime.agentId,
            "another-delete",
            generation,
          ),
        ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETIREMENT_MISMATCH" });
        expect(await authority.generation("unrelated-agent")).toBe("initial");
      });
      await fs.writeFile(path.join(pgliteDir, "pgdata.bin"), "after deletion");
      await withAgentBackupAuthority(root, async (authority) => {
        await authority.completeRetirement(
          runtime.agentId,
          "family-delete-1",
          generation,
        );
        await authority.completeRetirement(
          runtime.agentId,
          "family-delete-1",
          generation,
        );
      });
      for (const snapshot of [old, legacy]) {
        await expect(
          restoreAgentSnapshot(runtime, snapshot),
        ).rejects.toMatchObject({ code: "AGENT_BACKUP_GENERATION_RETIRED" });
        expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
          "after deletion",
        );
      }
      const current = await createAgentSnapshot(runtime, {} as never);
      await withAgentBackupAuthority(root, async (authority) => {
        expect(await authority.retire(runtime.agentId, "family-delete-1")).toBe(
          generation,
        );
      });
      await expect(
        createAgentSnapshot(runtime, {} as never),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETIREMENT_PENDING" });
      await expect(
        restoreAgentSnapshot(runtime, current),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RETIREMENT_PENDING",
      });
      await withAgentBackupAuthority(root, (authority) =>
        authority.completeRetirement(
          runtime.agentId,
          "family-delete-1",
          generation,
        ),
      );
      const malicious = structuredClone(current);
      malicious.manifest.components.stateFiles.files.push({
        path: ".backup-authority/operation.lock",
        bytesBase64: Buffer.from("replace authority").toString("base64"),
        sha256: "0".repeat(64),
        size: 17,
      });
      await fs.writeFile(path.join(pgliteDir, "pgdata.bin"), "later change");
      await expect(
        restoreAgentSnapshot(runtime, malicious),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_AUTHORITY_INVALID" });
      expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
        "later change",
      );
      await restoreAgentSnapshot(runtime, current);
      expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
        "after deletion",
      );
      expect(
        await withAgentBackupAuthority(root, (authority) =>
          authority.generation(runtime.agentId),
        ),
      ).toBe(generation);
      const moduleUrl = new URL("./agent-backup-authority.ts", import.meta.url)
        .href;
      const child = await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "--eval",
        `
        const { withAgentBackupAuthority } = await import(${JSON.stringify(moduleUrl)});
        const generation = await withAgentBackupAuthority(${JSON.stringify(root)}, (authority) => authority.generation(${JSON.stringify(runtime.agentId)}));
        process.stdout.write(generation);
      `,
      ]);
      expect(child.stdout).toBe(generation);
      await expect(restoreAgentSnapshot(runtime, old)).rejects.toMatchObject({
        code: "AGENT_BACKUP_GENERATION_RETIRED",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a held filesystem claim rejects competing capture before collecting state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-contention-"));
    process.env.ELIZA_STATE_DIR = root;
    try {
      await withAgentBackupAuthority(root, async () => {
        await expect(
          createAgentSnapshot(runtimeStub("agent"), {} as never),
        ).rejects.toMatchObject({ code: "AGENT_BACKUP_AUTHORITY_UNAVAILABLE" });
      });
      await fs.writeFile(
        path.join(root, ".backup-authority", "operation.lock"),
        "interrupted claim",
      );
      await expect(
        withAgentBackupAuthority(root, async () => true),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_AUTHORITY_UNAVAILABLE" });
      expect(
        await readText(path.join(root, ".backup-authority", "operation.lock")),
      ).toBe("interrupted claim");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("captures and restores local PGlite, media, vault, character, and state-dir files", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);

    const runtime = runtimeStub("11111111-1111-4111-8111-111111111111");
    const snapshot = await createAgentSnapshot(runtime, {
      agents: { defaults: { workspace: "/tmp/workspace" } },
    } as never);

    expect(snapshot.manifest.components.database.kind).toBe("pglite-files");
    expect(snapshot.manifest.components.media.files).toHaveLength(1);
    expect(
      snapshot.manifest.components.vault.files.map((file) => file.path).sort(),
    ).toEqual([".vault-pglite/data.bin", "audit/vault.jsonl", "vault.json"]);
    const stateFilePaths = snapshot.manifest.components.stateFiles.files.map(
      (file) => file.path,
    );
    const pgliteComponent = snapshot.manifest.components.database.pglite;
    if (!pgliteComponent) {
      throw new Error("Expected PGlite file-set backup component");
    }
    const pgliteFilePaths = pgliteComponent.files.map((file) => file.path);
    expect(pgliteFilePaths).toContain("pgdata.bin");
    expect(pgliteFilePaths).not.toContain("postmaster.pid");
    expect(pgliteFilePaths).not.toContain("postmaster.opts");
    expect(pgliteFilePaths).not.toContain("eliza-pglite.lock");
    expect(pgliteFilePaths).not.toContain("pg_stat_tmp/stats.tmp");
    expect(stateFilePaths).toContain("skills/active.json");
    expect(stateFilePaths).toContain("skills/.cache/lock.json");
    expect(stateFilePaths).not.toContain("skills/.cache/catalog.json");
    expect(stateFilePaths).not.toContain("pglite/pgdata.bin");
    // #17920: models + cache trees are excluded from the stateFiles manifest.
    expect(stateFilePaths).not.toContain("models/openai.json");
    expect(stateFilePaths).not.toContain("models/weights/giant.bin");
    expect(stateFilePaths).not.toContain("tool-cache/web-search.bin");
    expect(stateFilePaths).not.toContain("cache/runtime.tmp");
    expect(
      stateFilePaths.every(
        (filePath) =>
          !filePath.startsWith("models/") &&
          !filePath.startsWith("tool-cache/") &&
          !filePath.startsWith("cache/"),
      ),
    ).toBe(true);

    await fs.rm(path.join(root, "media"), { recursive: true, force: true });
    await fs.rm(path.join(root, ".vault-pglite"), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, "skills"), { recursive: true, force: true });
    await fs.rm(pgliteDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "vault.json"), { force: true });
    await fs.rm(path.join(root, "eliza.json"), { force: true });

    await fs.mkdir(path.join(root, ".vault-pglite"), { recursive: true });
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".vault-pglite", "stale.bin"),
      "stale-vault",
    );
    await fs.writeFile(path.join(root, "skills", "stale.json"), "stale-state");

    await restoreAgentSnapshot(runtime, snapshot);

    expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
      "database-bytes",
    );
    expect(await exists(path.join(pgliteDir, "postmaster.pid"))).toBe(false);
    expect(await exists(path.join(pgliteDir, "postmaster.opts"))).toBe(false);
    expect(await exists(path.join(pgliteDir, "eliza-pglite.lock"))).toBe(false);
    expect(await exists(path.join(pgliteDir, "pg_stat_tmp", "stats.tmp"))).toBe(
      false,
    );
    expect(
      await readText(path.join(root, "media", `${"a".repeat(64)}.txt`)),
    ).toBe("media-bytes");
    expect(await readText(path.join(root, ".vault-pglite", "data.bin"))).toBe(
      "ciphertext-ish",
    );
    expect(await readText(path.join(root, "audit", "vault.jsonl"))).toBe(
      '{"event":"unlock"}\n',
    );
    expect(await readText(path.join(root, "skills", "active.json"))).toBe(
      '{"skills":[]}\n',
    );
    expect(await readText(path.join(root, "eliza.json"))).toBe(
      '{"name":"fixture"}\n',
    );
    expect(await exists(path.join(root, ".vault-pglite", "stale.bin"))).toBe(
      false,
    );
    expect(await exists(path.join(root, "skills", "stale.json"))).toBe(false);
  });

  test("refuses to restore tampered component bytes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);
    const runtime = runtimeStub("22222222-2222-4222-8222-222222222222");
    const snapshot = (await createAgentSnapshot(
      runtime,
      {} as never,
    )) as AgentBackupStateData;

    const firstMedia = snapshot.manifest.components.media.files[0];
    if (!firstMedia) throw new Error("fixture did not create media");
    firstMedia.bytesBase64 = Buffer.from("tampered").toString("base64");

    await expect(restoreAgentSnapshot(runtime, snapshot)).rejects.toThrow(
      /hash mismatch/,
    );
  });

  test("captures live PGlite through the bounded leased exporter", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);

    const dumpBytes = Buffer.from("official-pglite-dump-bytes");
    let releases = 0;
    const runtime = {
      ...runtimeStub("44444444-4444-4444-8444-444444444444"),
      adapter: boundedPgliteAdapter(
        pgliteDir,
        () => new Blob([dumpBytes], { type: "application/gzip" }),
        () => {
          releases += 1;
        },
      ),
    } as unknown as AgentRuntime;

    const snapshot = await createAgentSnapshot(runtime, {} as never);

    expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");
    const pgliteDump = snapshot.manifest.components.database.pgliteDump;
    expect(pgliteDump?.compression).toBe("gzip");
    expect(pgliteDump?.file.path).toBe("pglite-data-dir.tar.gz");
    expect(Buffer.from(pgliteDump?.file.bytesBase64 ?? "", "base64")).toEqual(
      dumpBytes,
    );
    expect(snapshot.manifest.components.database.pglite).toBeUndefined();
    expect(releases).toBe(1);
  });

  test("captures through the adapter's lifecycle-serialized PGlite operation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await writeFixtureState(root, pgliteDir);

    let captures = 0;
    const runtime = {
      ...runtimeStub("55555555-5555-4555-8555-555555555555"),
      adapter: boundedPgliteAdapter(pgliteDir, async () => {
        captures += 1;
        return new Blob(["captured"], { type: "application/gzip" });
      }),
    } as unknown as AgentRuntime;

    const snapshot = await createAgentSnapshot(runtime, {} as never);

    expect(captures).toBe(1);
    expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");
  });

  test("surfaces repeated closing errors as transient without masking other failures", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await writeFixtureState(root, pgliteDir);

    const snapshotWithError = (message: string, code?: string) => {
      const runtime = {
        ...runtimeStub("66666666-6666-4666-8666-666666666666"),
        adapter: boundedPgliteAdapter(pgliteDir, async () => {
          throw Object.assign(new Error(message), code ? { code } : {});
        }),
      } as unknown as AgentRuntime;
      return createAgentSnapshot(runtime, {} as never);
    };

    await expect(snapshotWithError("connection is closing")).rejects.toThrow(
      PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
    );
    await expect(
      snapshotWithError(
        "rss budget exhausted",
        "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
      ),
    ).rejects.toThrow(PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT);
    await expect(
      snapshotWithError(
        "directory changed",
        "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED",
      ),
    ).rejects.toThrow(PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT);
    await expect(
      snapshotWithError("failed while closing corrupted WAL segment"),
    ).rejects.toThrow("failed while closing corrupted WAL segment");
  });

  test("backup cleanup review authenticates retired copies and refuses incomplete inventories", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "backup-cleanup-review-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.NODE_ENV = "test";
    process.env.ELIZA_KMS_BACKEND = "memory";
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    try {
      await writeFixtureState(root, pgliteDir);
      const runtime = runtimeStub("33333333-3333-4333-8333-333333333333");
      const foreign = runtimeStub("44444444-4444-4444-8444-444444444444");
      const old = await createLocalAgentBackup(runtime, {} as never);
      const other = await createLocalAgentBackup(foreign, {} as never);
      expect(
        (await reviewRetiredLocalAgentBackups(runtime.agentId)).archives,
      ).toEqual([]);
      await withAgentBackupAuthority(root, async (authority) => {
        const generation = await authority.retire(
          runtime.agentId,
          "cleanup-review",
        );
        await authority.completeRetirement(
          runtime.agentId,
          "cleanup-review",
          generation,
        );
      });
      const current = await createLocalAgentBackup(runtime, {} as never);
      const review = await reviewRetiredLocalAgentBackups(runtime.agentId);
      expect(review.archives.map((archive) => archive.fileName)).toEqual([
        old.fileName,
      ]);
      expect(review.archives[0]?.sizeBytes).toBe(
        (await fs.readFile(old.path)).length,
      );
      const originalOther = await fs.readFile(other.path);
      expect(await fs.readFile(current.path)).not.toHaveLength(0);
      expect(await fs.readFile(other.path)).toEqual(originalOther);

      // A misleading foreign-agent header cannot bypass authentication.
      const envelope = JSON.parse(await fs.readFile(old.path, "utf8"));
      envelope.agentId = foreign.agentId;
      const originalOld = await fs.readFile(old.path);
      await fs.writeFile(old.path, JSON.stringify(envelope));
      await expect(
        reviewRetiredLocalAgentBackups(runtime.agentId),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_REVIEW_UNAVAILABLE",
      });
      await fs.writeFile(old.path, originalOld);
      const alias = path.join(
        path.dirname(old.path),
        "alias.agent-backup.json",
      );
      await fs.symlink(old.path, alias);
      await expect(
        reviewRetiredLocalAgentBackups(runtime.agentId),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_REVIEW_UNAVAILABLE",
      });
      await fs.unlink(alias);
      await fs.writeFile(alias, "corrupt archive");
      await expect(
        reviewRetiredLocalAgentBackups(runtime.agentId),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_REVIEW_UNAVAILABLE",
      });
      expect(await fs.readFile(old.path)).toEqual(originalOld);
      expect(await fs.readFile(other.path)).toEqual(originalOther);
      await fs.unlink(alias);
      const admission = {
        ...review,
        notBefore: new Date(Date.now() - 1000).toISOString(),
      };
      const originalCurrent = await fs.readFile(current.path);
      await expect(
        purgeAdmittedRetiredLocalAgentBackups(runtime.agentId, async () => ({
          ...admission,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        })),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETENTION_PENDING" });
      expect(await fs.readFile(old.path)).toEqual(originalOld);
      await fs.copyFile(old.path, alias);
      await expect(
        purgeAdmittedRetiredLocalAgentBackups(
          runtime.agentId,
          async () => admission,
        ),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_CLEANUP_STALE" });
      expect(await fs.readFile(old.path)).toEqual(originalOld);
      await fs.unlink(alias);
      // A valid foreign replacement must not be mistaken for an already removed file.
      await fs.writeFile(old.path, originalOther);
      await expect(
        purgeAdmittedRetiredLocalAgentBackups(
          runtime.agentId,
          async () => admission,
        ),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_CLEANUP_STALE" });
      expect(await fs.readFile(old.path)).toEqual(originalOther);
      await fs.writeFile(old.path, originalOld);
      await purgeAdmittedRetiredLocalAgentBackups(
        runtime.agentId,
        async () => admission,
      );
      await expect(fs.stat(old.path)).rejects.toMatchObject({ code: "ENOENT" });
      // Replaying the same durable admission reconciles a lost completion acknowledgement.
      await purgeAdmittedRetiredLocalAgentBackups(
        runtime.agentId,
        async () => admission,
      );
      expect(await fs.readFile(other.path)).toEqual(originalOther);
      expect(await fs.readFile(current.path)).toEqual(originalCurrent);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("writes encrypted local backup files and restores them", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-agent-backup-"),
    );
    const pgliteDir = path.join(root, "pglite");
    process.env.NODE_ENV = "test";
    process.env.ELIZA_KMS_BACKEND = "memory";
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await writeFixtureState(root, pgliteDir);

    const runtime = runtimeStub("33333333-3333-4333-8333-333333333333");
    const backup = await createLocalAgentBackup(runtime, {} as never);
    const rawBackup = await readText(backup.path);

    expect(rawBackup).toContain("elizaos.agent-backup-file");
    expect(rawBackup).toContain("kms-aes-256-gcm");
    expect(rawBackup).not.toContain("media-bytes");
    expect(rawBackup).not.toContain("database-bytes");
    expect(rawBackup).not.toContain("ciphertext-ish");
    expect(rawBackup).not.toContain('{"skills":[]}');

    const listed = await listLocalAgentBackups(runtime.agentId);
    expect(listed.map((entry) => entry.fileName)).toEqual([backup.fileName]);
    expect(listed[0]?.stateSha256).toBe(backup.stateSha256);

    await fs.rm(path.join(root, "media"), { recursive: true, force: true });
    await fs.rm(path.join(root, ".vault-pglite"), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(root, "skills"), { recursive: true, force: true });
    await fs.rm(pgliteDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "vault.json"), { force: true });
    await fs.rm(path.join(root, "eliza.json"), { force: true });

    await restoreLocalAgentBackup(runtime, backup.fileName);

    expect(await readText(path.join(pgliteDir, "pgdata.bin"))).toBe(
      "database-bytes",
    );
    expect(
      await readText(path.join(root, "media", `${"a".repeat(64)}.txt`)),
    ).toBe("media-bytes");
    expect(await readText(path.join(root, ".vault-pglite", "data.bin"))).toBe(
      "ciphertext-ish",
    );
    expect(await readText(path.join(root, "audit", "vault.jsonl"))).toBe(
      '{"event":"unlock"}\n',
    );
    expect(await readText(path.join(root, "skills", "active.json"))).toBe(
      '{"skills":[]}\n',
    );
    expect(await readText(path.join(root, "eliza.json"))).toBe(
      '{"name":"fixture"}\n',
    );
  });
});

describe("source-side snapshot budget (#17172 §1)", () => {
  async function fixtureRoot(): Promise<{ root: string; pgliteDir: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-budget-"));
    const pgliteDir = path.join(root, "pglite");
    process.env.ELIZA_STATE_DIR = root;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    await writeFixtureState(root, pgliteDir);
    return { root, pgliteDir };
  }

  const config = {
    agents: { defaults: { workspace: "/tmp/workspace" } },
  } as never;
  const runtime = () => runtimeStub("11111111-1111-4111-8111-111111111111");

  test("refuses a capture whose files exceed the byte budget", async () => {
    const { root } = await fixtureRoot();
    // A media file comfortably past a deliberately tiny budget.
    await fs.writeFile(
      path.join(root, "media", "big.bin"),
      Buffer.alloc(64 * 1024, 7),
    );

    await expect(
      createAgentSnapshot(runtime(), config, { maxRawBytes: 4096 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("refuses BEFORE reading the oversized file, not after materializing it", async () => {
    // The refusal must come from the declared size: an entry transiently costs
    // ~2.33x its bytes, so charging post-read is charging post-damage.
    const { root } = await fixtureRoot();
    const bigPath = path.join(root, "media", "big.bin");
    await fs.writeFile(bigPath, Buffer.alloc(256 * 1024, 3));

    const realReadFile = fs.readFile;
    const readPaths: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test double for a node API
    (fs as any).readFile = async (target: any, ...rest: any[]) => {
      readPaths.push(String(target));
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real API
      return (realReadFile as any)(target, ...rest);
    };
    try {
      await expect(
        createAgentSnapshot(runtime(), config, { maxRawBytes: 4096 }),
      ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
      expect(readPaths).not.toContain(bigPath);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring the real API
      (fs as any).readFile = realReadFile;
    }
  });

  test("refuses a capture with more files than the count budget", async () => {
    const { root } = await fixtureRoot();
    const mediaDir = path.join(root, "media");
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(mediaDir, `f${i}.bin`), "x");
    }

    await expect(
      createAgentSnapshot(runtime(), config, { maxFiles: 3 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("an already-aborted signal stops the capture", async () => {
    await fixtureRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createAgentSnapshot(runtime(), config, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  test("a capture within budget still succeeds unchanged", async () => {
    await fixtureRoot();
    const snapshot = await createAgentSnapshot(runtime(), config);
    expect(snapshot.manifest.components.media.files.length).toBeGreaterThan(0);
  });

  test.each(["bytes", "files"] as const)(
    "generated plugin imports do not exhaust the %s budget or discard plugin state",
    async (limit) => {
      const { root } = await fixtureRoot();
      const generated = path.join(
        root,
        "plugins",
        ".runtime-imports",
        "plugin",
      );
      await fs.mkdir(generated, { recursive: true });
      if (limit === "bytes") {
        await fs.writeFile(
          path.join(generated, "bundle.js"),
          Buffer.alloc(128 * 1024),
        );
      } else {
        await Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            fs.writeFile(path.join(generated, `${i}.js`), "cache"),
          ),
        );
      }
      const retainedPath = "plugins/.runtime-imports-user.json";
      await fs.writeFile(
        path.join(root, retainedPath),
        "user-owned plugin settings",
      );
      const snapshot = await createAgentSnapshot(runtime(), config, {
        maxRawBytes: 64 * 1024,
        maxFiles: 30,
      });
      const files = snapshot.manifest.components.stateFiles.files;
      expect(
        files.some((file) => file.path.startsWith("plugins/.runtime-imports/")),
      ).toBe(false);
      expect(
        files.find((file) => file.path === retainedPath)?.bytesBase64,
      ).toBe(Buffer.from("user-owned plugin settings").toString("base64"));
      expect(await fs.readdir(generated)).not.toHaveLength(0);
    },
  );

  test("charges the in-memory character and legacy config projections", async () => {
    await fixtureRoot();
    const oversizedCharacter = {
      ...runtime(),
      character: {
        name: "Backup Test Agent",
        bio: "x".repeat(32 * 1024),
      },
    } as unknown as AgentRuntime;
    await expect(
      createAgentSnapshot(oversizedCharacter, config, {
        maxRawBytes: 16 * 1024,
      }),
    ).rejects.toMatchObject({ stage: "runtime character" });

    const oversizedConfig = {
      agents: { defaults: { system: "x".repeat(32 * 1024) } },
    } as never;
    await expect(
      createAgentSnapshot(runtime(), oversizedConfig, {
        maxRawBytes: 16 * 1024,
      }),
    ).rejects.toMatchObject({ stage: "legacy config" });
  });

  test("refuses when JSON metadata pushes the final wire body over budget", async () => {
    await fixtureRoot();
    const baseline = await createAgentSnapshot(runtime(), config);
    const exactWireBytes = Buffer.byteLength(JSON.stringify(baseline), "utf8");

    await expect(
      createAgentSnapshot(runtime(), config, {
        maxRawBytes: exactWireBytes - 1,
      }),
    ).rejects.toMatchObject({
      stage: "final wire serialization",
      observedBytes: exactWireBytes,
      limitBytes: exactWireBytes - 1,
    });
  });

  test("refuses an oversized PGlite dump from Blob.size, before arrayBuffer()", async () => {
    const { pgliteDir } = await fixtureRoot();
    let materialized = false;
    const withDump = {
      ...runtime(),
      adapter: boundedPgliteAdapter(pgliteDir, async () => {
        return {
          size: 256 * 1024,
          arrayBuffer: async () => {
            materialized = true;
            return new ArrayBuffer(256 * 1024);
          },
        };
      }),
    } as unknown as AgentRuntime;

    await expect(
      createAgentSnapshot(withDump, config, { maxRawBytes: 4096 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
    // The refusal must come from the declared size: the dump is transiently
    // resident three times over (ArrayBuffer + Buffer + base64) once decoded.
    expect(materialized).toBe(false);
  });

  test("rejects a non-finite PGlite Blob size and releases its export lease", async () => {
    const { pgliteDir } = await fixtureRoot();
    let materialized = false;
    let releases = 0;
    const withDump = {
      ...runtime(),
      adapter: boundedPgliteAdapter(
        pgliteDir,
        async () => ({
          size: Number.NaN,
          arrayBuffer: async () => {
            materialized = true;
            return new ArrayBuffer(0);
          },
        }),
        () => {
          releases += 1;
        },
      ),
    } as unknown as AgentRuntime;

    await expect(createAgentSnapshot(withDump, config)).rejects.toThrow(
      "did not return a Blob/File",
    );
    expect(materialized).toBe(false);
    expect(releases).toBe(1);
  });

  test("refuses legacy Blob conversion when remaining memory cannot cover its copies", async () => {
    const { pgliteDir } = await fixtureRoot();
    vi.restoreAllMocks();
    vi.spyOn(process, "availableMemory")
      .mockReturnValueOnce(512 * 1024 * 1024)
      .mockReturnValue(
        AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS.availableMemoryHeadroomBytes,
      );
    let materialized = false;
    let releases = 0;
    const withDump = {
      ...runtime(),
      adapter: boundedPgliteAdapter(
        pgliteDir,
        async () => ({
          size: 1,
          arrayBuffer: async () => {
            materialized = true;
            return new ArrayBuffer(1);
          },
        }),
        () => {
          releases += 1;
        },
      ),
    } as unknown as AgentRuntime;

    await expect(createAgentSnapshot(withDump, config)).rejects.toThrow(
      PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
    );
    expect(materialized).toBe(false);
    expect(releases).toBe(1);
  });

  test("an in-budget PGlite dump is charged, so a sibling cannot spend the same bytes", async () => {
    const { root, pgliteDir } = await fixtureRoot();
    // Dump ~48 KiB + a 48 KiB media file: each fits a 96 KiB (base64) budget
    // alone, both together do not.
    const dumpBytes = Buffer.alloc(48 * 1024, 5);
    await fs.writeFile(
      path.join(root, "media", "big.bin"),
      Buffer.alloc(48 * 1024, 7),
    );
    const withDump = {
      ...runtime(),
      adapter: boundedPgliteAdapter(
        pgliteDir,
        async () => new Blob([dumpBytes], { type: "application/gzip" }),
      ),
    } as unknown as AgentRuntime;

    await expect(
      createAgentSnapshot(withDump, config, { maxRawBytes: 96 * 1024 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("refuses an oversized file on the pglite-files fallback walk", async () => {
    const { pgliteDir } = await fixtureRoot();
    // No bounded exporter on the stub adapter, so the capture takes the
    // legacy fallback file walk — which used to run with no budget at all.
    await fs.writeFile(
      path.join(pgliteDir, "oversized.wal"),
      Buffer.alloc(256 * 1024, 9),
    );

    await expect(
      createAgentSnapshot(runtime(), config, { maxRawBytes: 64 * 1024 }),
    ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
  });

  test("concurrent components cannot both pass the check and then allocate past the limit", async () => {
    const { root, pgliteDir } = await fixtureRoot();
    // Two 64 KiB files on two components that capture CONCURRENTLY, with a
    // budget that fits one but not both. An observe-only reserve lets each
    // sibling see zero charged bytes, pass, and read — the limit is then only
    // discovered after both payloads are resident. A real reservation is
    // synchronous, so whichever component reserves second is refused BEFORE
    // its read, whatever the interleaving.
    const mediaBig = path.join(root, "media", "big-a.bin");
    const pgliteBig = path.join(pgliteDir, "big-b.wal");
    await fs.writeFile(mediaBig, Buffer.alloc(64 * 1024, 1));
    await fs.writeFile(pgliteBig, Buffer.alloc(64 * 1024, 2));

    const realReadFile = fs.readFile;
    const readPaths: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test double for a node API
    (fs as any).readFile = async (target: any, ...rest: any[]) => {
      readPaths.push(String(target));
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real API
      return (realReadFile as any)(target, ...rest);
    };
    try {
      await expect(
        // 128 KiB of budget: one 64 KiB file costs ~87 KiB in base64.
        createAgentSnapshot(runtime(), config, { maxRawBytes: 128 * 1024 }),
      ).rejects.toBeInstanceOf(AgentSnapshotBudgetExceededError);
      const bigReads = readPaths.filter(
        (p) => p === mediaBig || p === pgliteBig,
      );
      expect(bigReads.length).toBeLessThanOrEqual(1);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring the real API
      (fs as any).readFile = realReadFile;
    }
  });
});

describe("snapshot budget reservation semantics", () => {
  test("a hold claims capacity other reserves must count", () => {
    const budget = new SnapshotBudget(200, 10);
    const hold = budget.reserve(100); // holds base64Length(100) = 136
    expect(() => budget.reserve(100)).toThrow(AgentSnapshotBudgetExceededError);
    hold.release();
    expect(() => budget.reserve(100)).not.toThrow();
  });

  test("commit converts the hold into a charge at the actual encoded size", () => {
    const budget = new SnapshotBudget(200, 10);
    const hold = budget.reserve(100);
    hold.commit(50); // actual entry smaller than declared
    // 50 charged, hold gone: 136 more fits again.
    expect(() => budget.reserve(100)).not.toThrow();
  });

  test("a settled token is inert on double settle", () => {
    const budget = new SnapshotBudget(400, 10);
    const hold = budget.reserve(100);
    hold.commit(50);
    hold.release(); // must not un-charge the committed bytes
    hold.commit(50); // must not double-charge
    const holds = [budget.reserve(100), budget.reserve(100)];
    for (const h of holds) h.release();
    // Exactly 50 charged in total: a 350-byte hold still fits under 400.
    expect(() => budget.reserve(255)).not.toThrow();
  });

  test("file count is enforced at commit time", () => {
    const budget = new SnapshotBudget(10_000, 2);
    budget.reserve(10).commit(10);
    budget.reserve(10).commit(10);
    const third = budget.reserve(10);
    expect(() => third.commit(10)).toThrow(AgentSnapshotBudgetExceededError);
  });
});

describe("keyset-batched Postgres capture (#17172 §1)", () => {
  /** A pool double that serves `total` rows with sequential ids, in pages. */
  function pagingPool(total: number) {
    const statements: string[] = [];
    const all = Array.from({ length: total }, (_, i) => ({
      id: i + 1,
      payload: "x",
    }));
    return {
      statements,
      pageSizes: [] as number[],
      query(text: string, values: unknown[]) {
        statements.push(text);
        const limitMatch = text.match(/LIMIT (\d+)/);
        const limit = limitMatch ? Number(limitMatch[1]) : all.length;
        // The keyset param is appended after the base params.
        const after = values.length > 1 ? Number(values[values.length - 1]) : 0;
        const rows = all.filter((r) => r.id > after).slice(0, limit);
        this.pageSizes.push(rows.length);
        return Promise.resolve({ rows });
      },
    };
  }

  test("walks the whole table in ordered batches without duplicates or gaps", async () => {
    const pool = pagingPool(1200);
    const rows = await fetchAgentScopedRowsBatched(
      pool as never,
      (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
      ["agent-1"],
      undefined,
      "t",
      '"id"',
    );

    expect(rows).toHaveLength(1200);
    const ids = rows.map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(1200);
    // More than one round-trip: the point is that no single statement returned
    // the whole table.
    expect(pool.statements.length).toBeGreaterThan(1);
    expect(Math.max(...pool.pageSizes)).toBeLessThanOrEqual(500);
  });

  test("every statement is ordered and bounded by a LIMIT", async () => {
    const pool = pagingPool(700);
    await fetchAgentScopedRowsBatched(
      pool as never,
      (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
      ["agent-1"],
      undefined,
      "t",
      '"id"',
    );
    for (const sql of pool.statements) {
      expect(sql).toMatch(/ORDER BY "id"/);
      expect(sql).toMatch(/LIMIT \d+/);
    }
    // Pages after the first must resume from the last id, not re-scan.
    expect(pool.statements.slice(1).every((s) => /"id" > \$2/.test(s))).toBe(
      true,
    );
  });

  test("fails instead of returning a partial dump when a page cannot advance", async () => {
    const pool = {
      query: () =>
        Promise.resolve({
          rows: Array.from({ length: 500 }, () => ({ payload: "missing-id" })),
        }),
    };

    await expect(
      fetchAgentScopedRowsBatched(
        pool,
        (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
        ["agent-1"],
        undefined,
        "t",
        '"id"',
      ),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_KEYSET_ID_MISSING",
    });
  });

  test("an over-budget table is refused mid-walk, before the rest is read", async () => {
    const pool = pagingPool(5000);
    // A budget far smaller than the full table but bigger than one batch.
    const budget = new (class {
      private used = 0;
      check() {}
      chargeRaw(bytes: number) {
        this.used += bytes;
        if (this.used > 20_000) throw new Error("over budget");
      }
    })();

    await expect(
      fetchAgentScopedRowsBatched(
        pool as never,
        (keyset) => `SELECT * FROM "t" WHERE "agent_id" = $1 ${keyset}`,
        ["agent-1"],
        budget as never,
        "t",
        '"id"',
      ),
    ).rejects.toThrow("over budget");

    // Stopped early: it never issued the statements needed to read 5000 rows.
    expect(pool.statements.length).toBeLessThan(10);
  });
});
