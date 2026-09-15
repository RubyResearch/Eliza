/** Measures the actual backup-listing boundary without exposing backup paths. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InferenceTurnTimer, runWithInferenceTiming } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLocalAgentBackups } from "./agent-backup.ts";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-backup-timing-"));
  vi.stubEnv("ELIZA_STATE_DIR", root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("local backup listing timing", () => {
  it("returns an empty listing only after confirming the directory is missing", async () => {
    const timer = new InferenceTurnTimer({ turnId: "missing", label: "test" });
    expect(
      await runWithInferenceTiming(timer, () => listLocalAgentBackups()),
    ).toEqual([]);
    const summary = timer.close();
    expect(summary.spans.map(({ name }) => name)).toEqual([
      "local-backups:directory-list",
      "local-backups:directory-stat",
    ]);
    expect(summary.spans.every(({ meta }) => meta === undefined)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(root);
  });

  it("records directory listing while preserving metadata and agent filtering", async () => {
    const directory = path.join(root, "backups");
    await fs.mkdir(directory);
    const fileName = "fixture.agent-backup.json";
    const envelope = {
      format: "elizaos.agent-backup-file",
      schemaVersion: 1,
      agentId: "owner-agent",
      createdAt: "2026-09-05T00:00:00.000Z",
      stateSha256: "fixture-hash",
    };
    const body = JSON.stringify(envelope);
    await fs.writeFile(path.join(directory, fileName), body);
    const directoryStat = vi.spyOn(fs, "lstat");
    const timer = new InferenceTurnTimer({ turnId: "present", label: "test" });
    expect(
      await runWithInferenceTiming(timer, () =>
        listLocalAgentBackups(envelope.agentId),
      ),
    ).toEqual([
      {
        fileName,
        path: path.join(directory, fileName),
        createdAt: envelope.createdAt,
        agentId: envelope.agentId,
        stateSha256: envelope.stateSha256,
        sizeBytes: Buffer.byteLength(body),
      },
    ]);
    const summary = timer.close();
    expect(summary.spans.map(({ name }) => name)).toEqual([
      "local-backups:directory-list",
    ]);
    expect(directoryStat).not.toHaveBeenCalled();
    expect(summary.spans.every(({ meta }) => meta === undefined)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(root);
    expect(JSON.stringify(summary)).not.toContain(envelope.agentId);
    expect(await listLocalAgentBackups("another-agent")).toEqual([]);
  });

  it("preserves a filesystem denial and closes its timing span", async () => {
    const failure = Object.assign(new Error("fixture denial"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
    const timer = new InferenceTurnTimer({ turnId: "denied", label: "test" });
    await expect(
      runWithInferenceTiming(timer, () => listLocalAgentBackups()),
    ).rejects.toBe(failure);
    expect(timer.close().spans.map(({ name }) => name)).toEqual([
      "local-backups:directory-list",
    ]);
  });

  it("does not hide a dangling backup-directory symlink as an empty listing", async () => {
    await fs.symlink(
      path.join(root, "missing-target"),
      path.join(root, "backups"),
    );
    await expect(listLocalAgentBackups()).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not turn a failed missing-directory check into an empty listing", async () => {
    const failure = Object.assign(new Error("fixture denial"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure);
    await expect(listLocalAgentBackups()).rejects.toBe(failure);
  });

  it("preserves a non-directory error", async () => {
    await fs.writeFile(path.join(root, "backups"), "not a directory");
    await expect(listLocalAgentBackups()).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("still lists through an existing directory symlink", async () => {
    const target = path.join(root, "actual-backups");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(root, "backups"));
    expect(await listLocalAgentBackups()).toEqual([]);
  });
});
