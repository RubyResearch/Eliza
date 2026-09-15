/** Real filesystem listing: unchanged encrypted bodies are not reread, while
 * live file replacement, deletion and agent filtering remain authoritative. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listLocalAgentBackups } from "./agent-backup.ts";

let root: string;
const envelope = {
  format: "elizaos.agent-backup-file",
  schemaVersion: 1,
  agentId: "agent-a",
  createdAt: "2026-09-13T00:00:00Z",
  stateSha256: "hash-a",
  ciphertext: "opaque-ciphertext".repeat(1000),
};
const fileName = "fixture.agent-backup.json";
const file = () => path.join(root, "backups", fileName);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-backup-list-"));
  vi.stubEnv("ELIZA_STATE_DIR", root);
  await fs.mkdir(path.join(root, "backups"));
  await fs.writeFile(file(), JSON.stringify(envelope));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("reuses unchanged metadata without exposing ciphertext or sharing mutable results", async () => {
  const reads = vi.spyOn(fs, "readFile"); // pass through to the actual filesystem
  const first = await listLocalAgentBackups("agent-a");
  expect(first).toHaveLength(1);
  const original = { ...first[0] };
  first[0].stateSha256 = "caller mutation";
  expect(await listLocalAgentBackups("agent-a")).toEqual([original]);
  expect(await listLocalAgentBackups("agent-b")).toEqual([]);
  expect(await listLocalAgentBackups()).toEqual([original]);
  expect(reads.mock.calls.filter(([name]) => name === file())).toHaveLength(1);
  expect(JSON.stringify(original)).not.toContain(envelope.ciphertext);
});

it("refreshes same-size edits with restored mtime, replacement, addition and deletion", async () => {
  await listLocalAgentBackups();
  const before = await fs.stat(file());
  await fs.writeFile(
    file(),
    JSON.stringify({ ...envelope, stateSha256: "hash-b" }),
  );
  await fs.utimes(file(), before.atime, before.mtime);
  expect((await listLocalAgentBackups())[0].stateSha256).toBe("hash-b");
  const replacement = `${file()}.replacement`;
  await fs.writeFile(
    replacement,
    JSON.stringify({ ...envelope, agentId: "agent-b" }),
  );
  await fs.rename(replacement, file());
  expect(await listLocalAgentBackups("agent-a")).toEqual([]);
  expect(await listLocalAgentBackups("agent-b")).toHaveLength(1);
  await fs.writeFile(
    path.join(root, "backups", "new.agent-backup.json"),
    JSON.stringify(envelope),
  );
  expect(await listLocalAgentBackups()).toHaveLength(2);
  await fs.unlink(file());
  expect(await listLocalAgentBackups("agent-b")).toEqual([]);
  expect(await listLocalAgentBackups("agent-a")).toHaveLength(1);
});

it("does not return cached metadata after a corrupt edit or stat denial", async () => {
  await listLocalAgentBackups();
  await fs.writeFile(file(), "{broken");
  expect(await listLocalAgentBackups()).toEqual([]);
  await fs.writeFile(file(), JSON.stringify(envelope));
  expect(await listLocalAgentBackups()).toHaveLength(1);
  vi.spyOn(fs, "stat").mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  expect(await listLocalAgentBackups()).toEqual([]);
});

it("returns every backup even when there are more files than cache slots", async () => {
  await Promise.all(
    Array.from({ length: 130 }, (_, i) =>
      fs.writeFile(
        path.join(root, "backups", `${i}.agent-backup.json`),
        JSON.stringify(envelope),
      ),
    ),
  );
  const first = await listLocalAgentBackups();
  expect(first).toHaveLength(131);
  expect(await listLocalAgentBackups()).toEqual(first);
});

it("does not cache a file that changes while its body is read", async () => {
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
    const body = await read(...args);
    await fs.writeFile(
      file(),
      JSON.stringify({ ...envelope, stateSha256: "changed-during-read" }),
    );
    return body;
  });
  expect(await listLocalAgentBackups()).toEqual([]);
  expect((await listLocalAgentBackups())[0].stateSha256).toBe(
    "changed-during-read",
  );
});
