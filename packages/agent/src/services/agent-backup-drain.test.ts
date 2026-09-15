/** Real runtime and filesystem-backed PGlite proof for restore shutdown ordering. */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AgentRuntime, type IAgentRuntime, Service } from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentSnapshot, restoreAgentSnapshot } from "./agent-backup.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-restore-drain-"));
  const stateDir = path.join(root, "state");
  const dataDir = path.join(stateDir, ".pgdata");
  await fs.mkdir(path.join(stateDir, "media"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "eliza.json"), "{}\n");
  await fs.writeFile(path.join(stateDir, "media", "proof.txt"), "saved media");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("PGLITE_DATA_DIR", dataDir);
  vi.stubEnv("ELIZA_PGLITE_DISABLE_EXTENSIONS", "1");
  vi.stubEnv("POSTGRES_URL", undefined);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 * 1024);
  const agentId = "ca41ebfc-e094-466a-a193-0b5bb33287c3";
  const adapter = createDatabaseAdapter({ dataDir }, agentId) as ReturnType<
    typeof createDatabaseAdapter
  > & { getRawConnection(): PGlite; close(): Promise<void> };
  const source = adapter.getRawConnection();
  await source.waitReady;
  await source.exec(
    "CREATE TABLE restore_proof (value text NOT NULL); INSERT INTO restore_proof VALUES ('saved');",
  );
  const runtime = new AgentRuntime({ agentId, adapter });
  const snapshot = await createAgentSnapshot(runtime, {});
  await source.exec("UPDATE restore_proof SET value = 'current'");
  return { root, dataDir, adapter, source, runtime, snapshot };
}

test("drains active service database work before closing and restoring PGlite", async () => {
  const f = await fixture();
  const releaseWork = Promise.withResolvers<void>();
  const stopStarted = Promise.withResolvers<void>();
  const events: string[] = [];
  const task = releaseWork.promise.then(async () => {
    await f.source.exec("UPDATE restore_proof SET value = 'drained'");
    events.push("task-write");
  });
  // The test owns the worker result even when the original implementation
  // closes its database before releasing the controlled operation.
  void task.catch(() => undefined);
  class DatabaseWork extends Service {
    static serviceType = "task" as const;
    capabilityDescription = "Owns the controlled database operation";
    static async start(runtime: IAgentRuntime) {
      return new DatabaseWork(runtime);
    }
    async stop() {
      stopStarted.resolve();
      await task;
      events.push("service-drained");
    }
  }
  // Install the real service instance directly: this storage fixture does not
  // initialize the unrelated plugin/model graph behind lazy service startup.
  f.runtime.services.set(DatabaseWork.serviceType, [
    await DatabaseWork.start(f.runtime),
  ]);
  const close = f.adapter.close.bind(f.adapter);
  f.adapter.close = async () => {
    events.push("adapter-close");
    await close();
  };
  let restored: PGlite | undefined;
  const restoring = restoreAgentSnapshot(f.runtime, f.snapshot);
  try {
    const first = await Promise.race([
      stopStarted.promise.then(() => "draining"),
      restoring.then(() => "restored"),
    ]);
    expect(first).toBe("draining");
    expect(
      (await f.source.query("SELECT value FROM restore_proof")).rows,
    ).toEqual([{ value: "current" }]);
    expect(events).toEqual([]);
    releaseWork.resolve();
    await restoring;
    expect(events).toEqual(["task-write", "service-drained", "adapter-close"]);
    restored = new PGlite({ dataDir: f.dataDir });
    await restored.waitReady;
    expect(
      (await restored.query("SELECT value FROM restore_proof")).rows,
    ).toEqual([{ value: "saved" }]);
  } finally {
    releaseWork.resolve();
    await task.catch(() => undefined);
    await restoring.catch(() => undefined);
    await f.runtime.stop();
    await restored?.close();
    await f.adapter.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("rejects tampered later components while the current database remains usable", async () => {
  const f = await fixture();
  const stop = vi.spyOn(f.runtime, "stop");
  try {
    const file = f.snapshot.manifest.components.media.files[0];
    expect(file).toBeDefined();
    file.bytesBase64 = Buffer.from("tampered media").toString("base64");
    await expect(restoreAgentSnapshot(f.runtime, f.snapshot)).rejects.toThrow(
      /hash mismatch/,
    );
    expect(stop).not.toHaveBeenCalled();
    expect(
      (await f.source.query("SELECT value FROM restore_proof")).rows,
    ).toEqual([{ value: "current" }]);
  } finally {
    await f.runtime.stop();
    await f.adapter.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
