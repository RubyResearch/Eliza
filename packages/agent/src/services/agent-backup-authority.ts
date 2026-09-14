/**
 * Serializes local snapshot operations and durably retires obsolete restore generations.
 * Authority files are never backup payloads. An interrupted lock requires offline
 * reconciliation; elapsed time alone cannot prove that its writer stopped.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

export const AGENT_BACKUP_AUTHORITY_DIRECTORY = ".backup-authority";
export const INITIAL_AGENT_BACKUP_GENERATION = "initial";
const generationRecord = z.strictObject({
  agentId: z.string().min(1),
  generation: z.string().uuid(),
  operationId: z.string().min(1),
  phase: z.enum(["pending", "ready"]),
});
type GenerationRecord = z.infer<typeof generationRecord>;

export function isBackupAuthorityPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.split("/").includes(AGENT_BACKUP_AUTHORITY_DIRECTORY);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface AgentBackupAuthority {
  generation(agentId: string): Promise<string>;
  /** Retires earlier snapshots even if subsequent destructive work is uncertain. */
  retire(agentId: string, operationId: string): Promise<string>;
  pendingRetirement(
    agentId: string,
  ): Promise<{ operationId: string; generation: string } | null>;
  completeRetirement(
    agentId: string,
    operationId: string,
    generation: string,
  ): Promise<void>;
}

/** All users of a state directory share this process-independent exclusive claim. */
export async function withAgentBackupAuthority<T>(
  stateDir: string,
  operation: (authority: AgentBackupAuthority) => Promise<T>,
): Promise<T> {
  const directory = path.join(stateDir, AGENT_BACKUP_AUTHORITY_DIRECTORY);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ElizaError(
      "[AgentBackup] Backup authority must be a real directory",
      {
        code: "AGENT_BACKUP_AUTHORITY_INVALID",
      },
    );
  await syncDirectory(stateDir);
  const lockPath = path.join(directory, "operation.lock");
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
  } catch (cause) {
    // error-policy:J2 Never infer that an existing operation claim is stale.
    throw new ElizaError(
      "[AgentBackup] Backup authority is busy or requires offline reconciliation; stop all users before removing an abandoned claim",
      {
        code: "AGENT_BACKUP_AUTHORITY_UNAVAILABLE",
        context: { lockPath },
        cause,
      },
    );
  }
  let active = true;
  const generationPath = (agentId: string) => {
    if (!active || agentId.length === 0)
      throw new ElizaError("[AgentBackup] Backup authority is no longer held", {
        code: "AGENT_BACKUP_AUTHORITY_INVALID",
      });
    return path.join(
      directory,
      `${createHash("sha256").update(agentId).digest("hex")}.json`,
    );
  };
  const readRecord = async (
    agentId: string,
  ): Promise<GenerationRecord | null> => {
    const filePath = generationPath(agentId);
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (cause) {
      // error-policy:J4 Absence is the explicit legacy generation; other I/O failures remain errors.
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return null;
      throw cause;
    }
    try {
      if (!(await handle.stat()).isFile())
        throw new ElizaError("[AgentBackup] Generation is not a regular file", {
          code: "AGENT_BACKUP_AUTHORITY_INVALID",
        });
      const value = generationRecord.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
      if (value.agentId !== agentId)
        throw new ElizaError(
          "[AgentBackup] Backup generation belongs to another agent",
          { code: "AGENT_BACKUP_AUTHORITY_INVALID" },
        );
      return value;
    } catch (cause) {
      // error-policy:J2 Corrupt authority cannot be treated as an initial generation.
      if (cause instanceof ElizaError) throw cause;
      throw new ElizaError(
        "[AgentBackup] Backup authority is unreadable; reconcile it before continuing",
        { code: "AGENT_BACKUP_AUTHORITY_INVALID", cause },
      );
    } finally {
      await handle.close();
    }
  };
  const writeRecord = async (record: GenerationRecord): Promise<void> => {
    const destination = generationPath(record.agentId);
    const temporary = path.join(directory, `${randomUUID()}.pending`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
    await syncDirectory(directory);
  };
  const authority: AgentBackupAuthority = {
    async generation(agentId) {
      const record = await readRecord(agentId);
      if (record?.phase === "pending")
        throw new ElizaError(
          "[AgentBackup] Data deletion is incomplete; reconcile primary cleanup before creating or restoring snapshots",
          { code: "AGENT_BACKUP_RETIREMENT_PENDING" },
        );
      return record === null
        ? INITIAL_AGENT_BACKUP_GENERATION
        : record.generation;
    },
    async pendingRetirement(agentId) {
      const record = await readRecord(agentId);
      return record?.phase === "pending"
        ? { operationId: record.operationId, generation: record.generation }
        : null;
    },
    async retire(agentId, operationId) {
      z.string().min(1).parse(operationId);
      const record = await readRecord(agentId);
      if (record?.operationId === operationId) {
        if (record.phase === "ready")
          await writeRecord({ ...record, phase: "pending" });
        return record.generation;
      }
      if (record?.phase === "pending")
        throw new ElizaError(
          "[AgentBackup] Another deletion must be reconciled first",
          { code: "AGENT_BACKUP_RETIREMENT_PENDING" },
        );
      const generation = randomUUID();
      await writeRecord({ agentId, generation, operationId, phase: "pending" });
      return generation;
    },
    async completeRetirement(agentId, operationId, generation) {
      const record = await readRecord(agentId);
      if (
        !record ||
        record.operationId !== operationId ||
        record.generation !== generation
      )
        throw new ElizaError(
          "[AgentBackup] Cleanup acknowledgement does not match the pending deletion",
          { code: "AGENT_BACKUP_RETIREMENT_MISMATCH" },
        );
      if (record.phase === "ready") return;
      await writeRecord({ ...record, phase: "ready" });
    },
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, operationId: randomUUID() }),
    );
    await lock.sync();
    await syncDirectory(directory);
    outcome = { ok: true, value: await operation(authority) };
  } catch (cause) {
    // error-policy:J2 Preserve operation failure if releasing authority also fails.
    outcome = { ok: false, error: cause };
  }
  active = false;
  try {
    await lock.close();
    await fs.unlink(lockPath);
    await syncDirectory(directory);
  } catch (cause) {
    // error-policy:J2 The caller must reconcile any effect whose release was not acknowledged.
    throw new ElizaError(
      "[AgentBackup] Backup authority release failed; reconcile the operation before retrying",
      {
        code: "AGENT_BACKUP_AUTHORITY_RELEASE_FAILED",
        cause: new AggregateError(
          outcome.ok ? [cause] : [outcome.error, cause],
        ),
        context: { lockPath },
      },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
