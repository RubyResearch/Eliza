/** Exercises persisted operation recovery with real files and an exited child process. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository";
import type { RuntimeOperation } from "../../../src/runtime/operations/types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it.each(["dead", "alive", "remote", "legacy", "legacy-old"] as const)(
  "recovers only an abandoned local executor: %s",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "eliza-operation-owner-"));
    dirs.push(dir);
    const deadPid = Number(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(String(process.pid))"],
        { encoding: "utf8" },
      ),
    );
    const op: RuntimeOperation = {
      id: "interrupted-settings",
      kind: "restart",
      intent: { kind: "restart", reason: "settings test" },
      tier: "cold",
      status: "running",
      startedAt: Date.now() - (kind === "legacy" ? 0 : 180_000),
      phases: [],
      idempotencyKey: "do-not-replay",
      ...(kind === "legacy" || kind === "legacy-old"
        ? {}
        : {
            processOwner: {
              hostname: kind === "remote" ? "other-host.invalid" : hostname(),
              pid: kind === "alive" ? process.pid : deadPid,
            },
          }),
    };
    await mkdir(join(dir, "runtime-operations"));
    const file = join(dir, "runtime-operations", `${op.id}.json`);
    await writeFile(file, JSON.stringify(op));
    const repo = new FilesystemRuntimeOperationRepository(dir);
    expect((await repo.findActive())?.id ?? null).toBe(
      kind === "dead" || kind === "legacy-old" ? null : op.id,
    );
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.status).toBe(
      kind === "dead" || kind === "legacy-old" ? "failed" : "running",
    );
    if (kind === "dead") expect(stored.error.code).toBe("abandoned");
    expect((await repo.findByIdempotencyKey("do-not-replay"))?.id).toBe(op.id);
    expect(stored.intent).toEqual(op.intent);
  },
);
