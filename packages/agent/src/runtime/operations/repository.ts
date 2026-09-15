/**
 * Filesystem-backed RuntimeOperationRepository.
 *
 * Storage layout:
 *   <stateDir>/runtime-operations/<id>.json   one JSON file per operation
 *
 * In-memory caches are populated lazily at first access from disk and kept
 * in sync on every mutation. They make `findActive` and
 * `findByIdempotencyKey` O(1) on the hot path.
 *
 * Hydration:
 *   1. Reap abandoned ops — `pending`/`running` with a confirmed dead local
 *      executor or older than `ABANDONED_AFTER_MS` are marked `failed` with code
 *      `"abandoned"` (the process died mid-flight).
 *   2. Prune terminal ops — `succeeded`/`failed`/`rolled-back` records older
 *      than `RETENTION_MS` or beyond the `MAX_RECORDS` cap are deleted from
 *      disk and dropped from memory. Active ops are never pruned.
 *
 * Pruning also runs opportunistically after each `create` so a long-running
 * process doesn't accumulate state between hydrations.
 */

import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { readJsonFile, writeJsonAtomic } from "@elizaos/core/atomic-json";
import { formatError } from "@elizaos/shared";
import { resolveStateDir } from "../../config/paths.ts";
import type {
  OperationPhase,
  RuntimeOperation,
  RuntimeOperationListOptions,
  RuntimeOperationRepository,
} from "./types.ts";

const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_RECORDS = 200;

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface FilesystemRuntimeOperationRepositoryOptions {
  /** Override the retention window for terminal ops. */
  retentionMs?: number;
  /** Override the cap on the number of terminal ops kept. */
  maxRecords?: number;
}

function isTerminal(op: RuntimeOperation): boolean {
  return op.status !== "pending" && op.status !== "running";
}

/**
 * Strip the legacy plaintext `apiKey` field that older runtime-ops records
 * carried on `ProviderSwitchIntent` before the vault migration. Returns the
 * sanitized op plus a boolean signalling that the on-disk file needs
 * rewriting. The vault key is preserved (or re-derivable) by the route at
 * the next switch — we never re-emit the plaintext.
 */
function stripLegacyApiKey(op: RuntimeOperation): {
  op: RuntimeOperation;
  changed: boolean;
} {
  if (op.intent.kind !== "provider-switch") return { op, changed: false };
  const intent = op.intent as RuntimeOperation["intent"] & {
    apiKey?: unknown;
  };
  if (!("apiKey" in intent)) return { op, changed: false };
  const { apiKey: _legacy, ...sanitizedIntent } = intent;
  void _legacy;
  return {
    op: { ...op, intent: sanitizedIntent as RuntimeOperation["intent"] },
    changed: true,
  };
}

/** Reclaim only a known dead local executor; remote, legacy and uncertain owners stay active. */
function localExecutorExited(op: RuntimeOperation): boolean {
  const owner = op.processOwner;
  if (
    !owner ||
    owner.hostname !== hostname() ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  )
    return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // error-policy:J4 ESRCH proves the executor exited. Permission failures
    // and other ambiguous states retain the operation's busy gate.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function operationsDirFor(stateDir: string): string {
  return path.join(stateDir, "runtime-operations");
}

async function readOperationFile(
  filePath: string,
): Promise<RuntimeOperation | null> {
  const parsed = await readJsonFile<RuntimeOperation>(filePath);
  if (!parsed?.id || !parsed.kind || !Array.isArray(parsed.phases)) {
    return null;
  }
  return parsed;
}

export class FilesystemRuntimeOperationRepository
  implements RuntimeOperationRepository
{
  private readonly dir: string;
  private readonly byId: Map<string, RuntimeOperation> = new Map();
  private readonly byIdempotencyKey: Map<string, string> = new Map();
  private activeId: string | null = null;
  private hydration: Promise<void> | null = null;
  private readonly retentionMs: number;
  private readonly maxRecords: number;

  constructor(
    stateDir: string = resolveStateDir(),
    opts: FilesystemRuntimeOperationRepositoryOptions = {},
  ) {
    this.dir = operationsDirFor(stateDir);
    this.retentionMs =
      opts.retentionMs ??
      readEnvNumber("ELIZA_RUNTIME_OPS_RETENTION_MS", DEFAULT_RETENTION_MS);
    this.maxRecords =
      opts.maxRecords ??
      readEnvNumber("ELIZA_RUNTIME_OPS_MAX_RECORDS", DEFAULT_MAX_RECORDS);
  }

  private hydrate(): Promise<void> {
    if (this.hydration) return this.hydration;
    this.hydration = this.runHydrate();
    return this.hydration;
  }

  private async runHydrate(): Promise<void> {
    // mkdir is idempotent with recursive: true — no existence check needed.
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.dir);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const fullPath = path.join(this.dir, entry);
      const raw = await readOperationFile(fullPath);
      if (!raw) continue;

      // Migration: strip legacy plaintext `apiKey` from
      // ProviderSwitchIntent records written before the vault integration.
      // Re-persist the sanitized record so the file on disk loses the
      // secret too — pruning + idempotency keep working untouched.
      const stripped = stripLegacyApiKey(raw);
      const op = stripped.op;
      if (stripped.changed) {
        await writeJsonAtomic(fullPath, op, {
          trailingNewline: true,
          skipMkdir: true,
        });
        logger.info(
          `[runtime-ops] Migrated legacy plaintext apiKey out of ${op.id}`,
        );
      }

      // Reap abandoned operations: a process died with this op still "live".
      const isLive = op.status === "pending" || op.status === "running";
      const isStale = now - op.startedAt > ABANDONED_AFTER_MS;
      if (isLive && (op.processOwner ? localExecutorExited(op) : isStale)) {
        const reaped: RuntimeOperation = {
          ...op,
          status: "failed",
          finishedAt: now,
          error: {
            message: "Operation abandoned (process exited before completion)",
            code: "abandoned",
          },
        };
        await writeJsonAtomic(fullPath, reaped, {
          trailingNewline: true,
          skipMkdir: true,
        });
        this.byId.set(reaped.id, reaped);
        if (reaped.idempotencyKey) {
          this.byIdempotencyKey.set(reaped.idempotencyKey, reaped.id);
        }
        logger.info(
          `[runtime-ops] Reaped abandoned operation on hydrate: ${reaped.id}`,
        );
        continue;
      }

      this.byId.set(op.id, op);
      if (op.idempotencyKey) {
        this.byIdempotencyKey.set(op.idempotencyKey, op.id);
      }
      if (isLive && !this.activeId) {
        this.activeId = op.id;
      }
    }
    await this.pruneTerminal(now);
  }

  /**
   * Drop terminal ops that exceed the retention window or fall outside the
   * most-recent-N cap. Active (`pending`/`running`) ops are never touched —
   * the abandoned-reaper in {@link runHydrate} is the only path that can
   * transition them to terminal.
   *
   * Returns the number of ops removed.
   */
  async pruneTerminal(now: number = Date.now()): Promise<number> {
    const terminal = Array.from(this.byId.values())
      .filter(isTerminal)
      .sort(
        (a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt),
      );

    const toDrop: RuntimeOperation[] = [];
    for (let i = 0; i < terminal.length; i++) {
      const op = terminal[i];
      const tooOld = now - (op.finishedAt ?? op.startedAt) > this.retentionMs;
      const beyondCap = i >= this.maxRecords;
      if (tooOld || beyondCap) toDrop.push(op);
    }

    if (toDrop.length === 0) return 0;

    await Promise.all(
      toDrop.map((op) =>
        fs.rm(this.pathFor(op.id), { force: true }).catch((err) => {
          logger.warn(
            `[runtime-ops] Failed to unlink ${op.id}: ${formatError(err)}`,
          );
        }),
      ),
    );
    for (const op of toDrop) {
      this.byId.delete(op.id);
      if (op.idempotencyKey) this.byIdempotencyKey.delete(op.idempotencyKey);
    }
    logger.debug(`[runtime-ops] Pruned ${toDrop.length} terminal op(s)`);
    return toDrop.length;
  }

  private pathFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private persist(op: RuntimeOperation): Promise<void> {
    return writeJsonAtomic(this.pathFor(op.id), op, {
      trailingNewline: true,
      skipMkdir: true,
    });
  }

  private syncActiveSlot(op: RuntimeOperation): void {
    const isLive = op.status === "pending" || op.status === "running";
    if (isLive) {
      this.activeId = op.id;
      return;
    }
    if (this.activeId === op.id) {
      this.activeId = null;
    }
  }

  async create(op: RuntimeOperation): Promise<void> {
    await this.hydrate();
    if (this.byId.has(op.id)) {
      throw new Error(`[runtime-ops] Operation already exists: ${op.id}`);
    }
    await this.persist(op);
    this.byId.set(op.id, op);
    if (op.idempotencyKey) {
      this.byIdempotencyKey.set(op.idempotencyKey, op.id);
    }
    this.syncActiveSlot(op);
    void this.pruneTerminal().catch((err) => {
      logger.warn(
        `[runtime-ops] post-create prune failed: ${formatError(err)}`,
      );
    });
  }

  async update(
    id: string,
    patch: Partial<Omit<RuntimeOperation, "id" | "phases" | "intent" | "kind">>,
  ): Promise<void> {
    await this.hydrate();
    const current = this.byId.get(id);
    if (!current) {
      throw new Error(`[runtime-ops] Operation not found: ${id}`);
    }
    const next: RuntimeOperation = { ...current, ...patch };
    await this.persist(next);
    this.byId.set(id, next);
    this.syncActiveSlot(next);
  }

  async appendPhase(id: string, phase: OperationPhase): Promise<void> {
    await this.hydrate();
    const current = this.byId.get(id);
    if (!current) {
      throw new Error(`[runtime-ops] Operation not found: ${id}`);
    }
    const next: RuntimeOperation = {
      ...current,
      phases: [...current.phases, phase],
    };
    await this.persist(next);
    this.byId.set(id, next);
  }

  async updateLastPhase(
    id: string,
    patch: Partial<OperationPhase>,
  ): Promise<void> {
    await this.hydrate();
    const current = this.byId.get(id);
    if (!current) {
      throw new Error(`[runtime-ops] Operation not found: ${id}`);
    }
    const last = current.phases[current.phases.length - 1];
    if (!last) {
      throw new Error(
        `[runtime-ops] Cannot update last phase — no phases on op ${id}`,
      );
    }
    const merged: OperationPhase = { ...last, ...patch };
    const phases = [...current.phases.slice(0, -1), merged];
    const next: RuntimeOperation = { ...current, phases };
    await this.persist(next);
    this.byId.set(id, next);
  }

  async get(id: string): Promise<RuntimeOperation | null> {
    await this.hydrate();
    return this.byId.get(id) ?? null;
  }

  async list(opts?: RuntimeOperationListOptions): Promise<RuntimeOperation[]> {
    await this.hydrate();
    let ops = Array.from(this.byId.values());
    if (opts?.status) {
      ops = ops.filter((o) => o.status === opts.status);
    } else if (opts?.includeTerminal === false) {
      ops = ops.filter((o) => o.status === "pending" || o.status === "running");
    }
    ops.sort((a, b) => b.startedAt - a.startedAt);
    if (typeof opts?.limit === "number" && opts.limit >= 0) {
      ops = ops.slice(0, opts.limit);
    }
    return ops;
  }

  async findByIdempotencyKey(key: string): Promise<RuntimeOperation | null> {
    await this.hydrate();
    const id = this.byIdempotencyKey.get(key);
    if (!id) return null;
    const op = this.byId.get(id);
    if (!op) return null;
    if (Date.now() - op.startedAt > IDEMPOTENCY_RETENTION_MS) {
      return null;
    }
    return op;
  }

  async findActive(): Promise<RuntimeOperation | null> {
    await this.hydrate();
    if (!this.activeId) return null;
    const op = this.byId.get(this.activeId);
    if (!op) {
      this.activeId = null;
      return null;
    }
    if (op.status !== "pending" && op.status !== "running") {
      this.activeId = null;
      return null;
    }
    // New records carry executor identity, so a dead process releases the
    // gate immediately while a slow live operation keeps ownership. Retain
    // the existing age fallback only for legacy records with no owner.
    if (
      op.processOwner
        ? localExecutorExited(op)
        : Date.now() - op.startedAt > 2 * 60 * 1000
    ) {
      await this.update(op.id, {
        status: "failed",
        finishedAt: Date.now(),
        error: {
          code: "abandoned",
          message: "Operation abandoned by a previous process",
        },
      });
      this.activeId = null;
      return null;
    }
    return op;
  }
}

let cachedDefault: FilesystemRuntimeOperationRepository | null = null;

/**
 * Lazy per-process singleton. Constructed on first call so tests can swap
 * the env or provide their own repository before the manager is built.
 */
export function getDefaultRepository(): FilesystemRuntimeOperationRepository {
  if (!cachedDefault) {
    cachedDefault = new FilesystemRuntimeOperationRepository();
  }
  return cachedDefault;
}
