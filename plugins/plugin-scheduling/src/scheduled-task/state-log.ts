/**
 * State-log writer.
 *
 * The runner writes one row per state transition. The user-visible
 * `GET /api/lifeops/scheduled-tasks/:id/history` endpoint reads from
 * this log. Default 90-day retention with a nightly rollup pass that folds
 * expired entries into a daily-summary row per task per transition kind.
 * Creation receipts and receipt-keyed lifecycle commits stay raw for the
 * task's lifetime so an idempotent replay retains its durable proof identity.
 */

import type {
  ScheduledTaskLogEntry,
  ScheduledTaskLogTransition,
} from "./types.js";

export interface ScheduledTaskLogStore {
  append(entry: ScheduledTaskLogEntry): Promise<void>;
  list(args: {
    agentId: string;
    taskId: string;
    /** Inclusive lower bound (ISO). */
    sinceIso?: string;
    /** Exclusive upper bound (ISO). */
    untilIso?: string;
    /** When true, omit rolled-up summary rows. Default false. */
    excludeRollups?: boolean;
    limit?: number;
  }): Promise<ScheduledTaskLogEntry[]>;
  rollupOlderThan(args: {
    agentId: string;
    olderThanIso: string;
    /** Restrict maintenance to these task identities; an empty set changes no rows. */
    taskIds?: readonly string[];
  }): Promise<{ rolledUp: number; deletedRaw: number }>;
}

/**
 * In-memory store used for unit tests + as a fallback when no DB-backed
 * store is wired in. The DB-backed store lives in `store.ts` and is owned by
 * plugin-scheduling.
 */
export function createInMemoryScheduledTaskLogStore(): ScheduledTaskLogStore {
  const rows: ScheduledTaskLogEntry[] = [];
  return {
    async append(entry) {
      if (rows.some((row) => row.logId === entry.logId)) {
        throw new Error(`Scheduled task log ${entry.logId} already exists`);
      }
      rows.push({ ...entry });
    },
    async list({ agentId, taskId, sinceIso, untilIso, excludeRollups, limit }) {
      let view = rows
        .filter((r) => r.agentId === agentId && r.taskId === taskId)
        .filter((r) => (excludeRollups ? !r.rolledUp : true))
        .filter((r) => (sinceIso ? r.occurredAtIso >= sinceIso : true))
        .filter((r) => (untilIso ? r.occurredAtIso < untilIso : true))
        .sort((a, b) => (a.occurredAtIso < b.occurredAtIso ? -1 : 1));
      if (typeof limit === "number" && limit > 0) {
        view = view.slice(0, limit);
      }
      return view.map((r) => ({ ...r }));
    },
    async rollupOlderThan({ agentId, olderThanIso, taskIds }) {
      const expired = rows.filter(
        (r) =>
          r.agentId === agentId &&
          (taskIds === undefined || taskIds.includes(r.taskId)) &&
          !r.rolledUp &&
          r.transition !== "scheduled" &&
          typeof r.detail?.receiptKey !== "string" &&
          r.occurredAtIso < olderThanIso,
      );
      if (expired.length === 0) {
        return { rolledUp: 0, deletedRaw: 0 };
      }
      const summaryByKey = new Map<
        string,
        {
          taskId: string;
          transition: ScheduledTaskLogTransition;
          dayIso: string;
          count: number;
          firstReason?: string;
        }
      >();
      for (const row of expired) {
        const dayIso = row.occurredAtIso.slice(0, 10);
        const key = `${row.taskId}::${dayIso}::${row.transition}`;
        const existing = summaryByKey.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          summaryByKey.set(key, {
            taskId: row.taskId,
            transition: row.transition,
            dayIso,
            count: 1,
            firstReason: row.reason,
          });
        }
      }
      const summaries: ScheduledTaskLogEntry[] = [];
      let counter = 0;
      for (const [key, summary] of summaryByKey.entries()) {
        counter += 1;
        summaries.push({
          logId: `rollup:${key}:${counter}`,
          taskId: summary.taskId,
          agentId,
          occurredAtIso: `${summary.dayIso}T00:00:00.000Z`,
          transition: summary.transition,
          reason: summary.firstReason,
          rolledUp: true,
          detail: { rollupCount: summary.count },
        });
      }
      // Replace the expired raw rows with the new rollup rows.
      const expiredIds = new Set(expired.map((r) => r.logId));
      const remaining = rows.filter((r) => !expiredIds.has(r.logId));
      rows.length = 0;
      rows.push(...remaining, ...summaries);
      return { rolledUp: summaries.length, deletedRaw: expired.length };
    },
  };
}

export const STATE_LOG_DEFAULT_RETENTION_DAYS = 90;

/**
 * Build a logger that writes to the given store and updates the task's
 * `lastDecisionLog`. The runner uses this to wrap every state transition.
 */
export function createStateLogger(args: {
  store: ScheduledTaskLogStore;
  agentId: string;
  /** Generator override for tests (defaults to crypto.randomUUID). */
  newLogId?: () => string;
  /** Now override for tests. */
  now?: () => Date;
}): {
  log: (
    taskId: string,
    transition: ScheduledTaskLogTransition,
    args?: { reason?: string; detail?: Record<string, unknown> },
  ) => Promise<ScheduledTaskLogEntry>;
} {
  const newLogId =
    args.newLogId ?? (() => `stl_${Math.random().toString(36).slice(2, 12)}`);
  const now = args.now ?? (() => new Date());
  return {
    async log(taskId, transition, opts) {
      const entry: ScheduledTaskLogEntry = {
        logId: newLogId(),
        taskId,
        agentId: args.agentId,
        occurredAtIso: now().toISOString(),
        transition,
        reason: opts?.reason,
        rolledUp: false,
        detail: opts?.detail,
      };
      await args.store.append(entry);
      return entry;
    },
  };
}
