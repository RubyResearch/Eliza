/**
 * Exercises legacy file-only vault backup restoration with real PGlite data and
 * a fresh Node process. The agent runtime boundary is a stub; archive capture,
 * hashing, filesystem replacement and database recovery are real.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime } from "@elizaos/core";
import {
  AGENT_BACKUP_CANONICAL_JSON,
  stableJsonString,
} from "@elizaos/shared/canonical-json";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type AgentBackupStateData,
  createAgentSnapshot,
  restoreAgentSnapshot,
} from "./agent-backup.ts";

const originalEnvironment = Object.fromEntries(
  ["ELIZA_STATE_DIR", "PGLITE_DATA_DIR", "POSTGRES_URL", "DATABASE_URL"].map(
    (key) => [key, process.env[key]],
  ),
);
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const pgliteModule = createRequire(import.meta.url).resolve(
  "@electric-sql/pglite",
);

beforeEach(() => {
  vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 * 1024);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of temporaryRoots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-vault-layout-"));
  temporaryRoots.push(root);
  const runtimeDir = path.join(root, "runtime-db");
  const vaultDir = path.join(root, ".vault-pglite");
  process.env.ELIZA_STATE_DIR = root;
  process.env.PGLITE_DATA_DIR = runtimeDir;
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  await fs.mkdir(runtimeDir);
  await fs.writeFile(
    path.join(runtimeDir, "marker"),
    "runtime database before restore",
  );
  const database = await PGlite.create(vaultDir);
  try {
    await database.exec(
      "CREATE TABLE restore_proof(value text NOT NULL); INSERT INTO restore_proof VALUES ('before backup')",
    );
  } finally {
    await database.close();
  }
  const stop = vi.fn(async () => undefined);
  const runtime = {
    agentId: "c247090e-151e-4dd4-94d2-98e283d61553",
    character: { name: "Vault restore fixture" },
    adapter: { close: async () => undefined },
    stop,
    getSetting: () => null,
  } as unknown as AgentRuntime;
  const snapshot = await createAgentSnapshot(runtime, {} as never);
  return { root, runtimeDir, vaultDir, runtime, snapshot, stop };
}

function addVaultFile(
  snapshot: AgentBackupStateData,
  name: string,
  contents: string,
) {
  const bytes = Buffer.from(contents);
  const vault = snapshot.manifest.components.vault;
  vault.files = vault.files.filter((file) => file.path !== name);
  vault.files.push({
    path: name,
    size: bytes.length,
    bytesBase64: bytes.toString("base64"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
  vault.sha256 = crypto
    .createHash("sha256")
    .update(
      stableJsonString(
        vault.files.map(({ path: filePath, sha256, size }) => ({
          path: filePath,
          sha256,
          size,
        })),
        AGENT_BACKUP_CANONICAL_JSON,
      ),
    )
    .digest("hex");
  snapshot.manifest.integrity.componentHashes.vault = vault.sha256;
}

test("a file-only vault archive opens in a fresh process with the original records after restore", async () => {
  const { vaultDir, runtime, snapshot } = await fixture();
  const changed = await PGlite.create(vaultDir);
  try {
    await changed.exec("UPDATE restore_proof SET value = 'after backup'");
  } finally {
    await changed.close();
  }
  await restoreAgentSnapshot(runtime, snapshot);
  const child = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    const { PGlite } = await import(process.argv[2]);
    const database = await PGlite.create(process.argv[1]);
    try { process.stdout.write(JSON.stringify((await database.query('SELECT value FROM restore_proof')).rows)); }
    finally { await database.close(); }
  `,
    vaultDir,
    pgliteModule,
  ]);
  expect(JSON.parse(child.stdout)).toEqual([{ value: "before backup" }]);
}, 60000);

test.each([
  [
    ".vault-pglite/pg_notify",
    "directory replaced by file",
    "AGENT_BACKUP_VAULT_DIRECTORY_CONFLICT",
  ],
  [".vault-pglite/PG_VERSION", "999\n", "AGENT_BACKUP_VAULT_VERSION_MISMATCH"],
])(
  "rejects incompatible vault entry %s before stopping or replacing the runtime database",
  async (name, contents, code) => {
    const { runtime, snapshot, stop, runtimeDir } = await fixture();
    addVaultFile(snapshot, name, contents);
    await expect(restoreAgentSnapshot(runtime, snapshot)).rejects.toMatchObject(
      { code },
    );
    expect(stop).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(runtimeDir, "marker"), "utf8")).toBe(
      "runtime database before restore",
    );
  },
  60000,
);
