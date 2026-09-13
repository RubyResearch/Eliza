/**
 * Durable SQL-backed ScheduledTask store owned by plugin-scheduling.
 *
 * Hosts inject this adapter through `registerScheduledTaskRunnerDeps`, and the
 * scheduling plugin's default deps use it directly when a runtime database is
 * available. The row contract mirrors the runner's store interface exactly:
 * the runner computes `next_fire_at`, while this adapter owns atomic claims,
 * idempotency lookup, filtering, and state-log retention.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScheduledTaskClaimExpectation,
  ScheduledTaskClaimResult,
  ScheduledTaskStore,
  ScheduledTaskUpsertOptions,
} from "./runner.js";
import {
  createRuntimeSchedulingSqlExecutor,
  parseJsonRecord,
  type SchedulingSqlExecutor,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toText,
} from "./sql.js";
import type { ScheduledTaskLogStore } from "./state-log.js";
import type {
  ScheduledTask,
  ScheduledTaskFilter,
  ScheduledTaskLogEntry,
} from "./types.js";

const SCHEDULING_SCHEMA = "app_scheduling";
const TASK_TABLE = `${SCHEDULING_SCHEMA}.life_scheduled_tasks`;
const LOG_TABLE = `${SCHEDULING_SCHEMA}.life_scheduled_task_log`;

export interface DueScheduledTaskRef {
  agentId: string;
  taskId: string;
}

export interface RecoverableScheduledTaskRef extends DueScheduledTaskRef {
  firedAtIso: string;
}

/** Finds abandoned claims only after their bounded dispatch lease has expired. */
export async function listRecoverableScheduledTaskRefs(
  executeSql: SchedulingSqlExecutor,
  options: { updatedBeforeIso: string; limit?: number },
): Promise<RecoverableScheduledTaskRef[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const rows = await executeSql(
    `SELECT agent_id, id, state_json::jsonb ->> 'firedAt' AS fired_at
       FROM ${TASK_TABLE}
      WHERE kind = 'reminder'
        AND transfer_status IS NULL
        AND COALESCE(metadata_json::jsonb #>> '{sharedCutoverImport,status}', '') <> 'reserved'
        AND next_fire_at IS NULL
        AND state_json::jsonb ->> 'status' = 'fired'
        AND COALESCE(state_json::jsonb ->> 'firedAt', '') <> ''
        AND updated_at::timestamptz <= ${sqlQuote(options.updatedBeforeIso)}::timestamptz
        AND COALESCE((metadata_json::jsonb #>> '{lastDispatchResult,ok}')::boolean, FALSE) = FALSE
      ORDER BY updated_at ASC, agent_id ASC, id ASC
      LIMIT ${sqlInteger(limit)}`,
  );
  return rows.map((row) => ({
    agentId: toText(row.agent_id),
    taskId: toText(row.id),
    firedAtIso: toText(row.fired_at),
  }));
}

export async function listDueScheduledTaskRefs(
  executeSql: SchedulingSqlExecutor,
  options: { dueAtIso: string; limit?: number },
): Promise<DueScheduledTaskRef[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const rows = await executeSql(
    `SELECT agent_id, id
       FROM ${TASK_TABLE}
      WHERE kind = 'reminder'
        AND transfer_status IS NULL
        AND COALESCE(
          metadata_json::jsonb #>> '{sharedCutoverImport,status}',
          ''
        ) <> 'reserved'
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= ${sqlQuote(options.dueAtIso)}::timestamptz
        AND (state_json::jsonb ->> 'status') IN (
          'scheduled', 'fired', 'acknowledged', 'completed', 'skipped', 'expired', 'failed'
        )
      ORDER BY next_fire_at ASC, agent_id ASC, id ASC
      LIMIT ${sqlInteger(limit)}`,
  );
  return rows.map((row) => ({
    agentId: toText(row.agent_id),
    taskId: toText(row.id),
  }));
}

function isoNow(): string {
  return new Date().toISOString();
}

function parseOptionalJsonRecord<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.length === 0) return undefined;
  const parsed = parseJsonRecord(value);
  if (Object.keys(parsed).length === 0) return undefined;
  return parsed as T;
}

export function parseScheduledTaskRow(
  row: Record<string, unknown>,
): ScheduledTask {
  const stateRaw = parseJsonRecord(row.state_json);
  const state: ScheduledTask["state"] = {
    status: ((stateRaw.status as string) ??
      "scheduled") as ScheduledTask["state"]["status"],
    firedAt:
      typeof stateRaw.firedAt === "string" ? stateRaw.firedAt : undefined,
    acknowledgedAt:
      typeof stateRaw.acknowledgedAt === "string"
        ? stateRaw.acknowledgedAt
        : undefined,
    completedAt:
      typeof stateRaw.completedAt === "string"
        ? stateRaw.completedAt
        : undefined,
    followupCount:
      typeof stateRaw.followupCount === "number" ? stateRaw.followupCount : 0,
    lastFollowupAt:
      typeof stateRaw.lastFollowupAt === "string"
        ? stateRaw.lastFollowupAt
        : undefined,
    pipelineParentId:
      typeof stateRaw.pipelineParentId === "string"
        ? stateRaw.pipelineParentId
        : undefined,
    lastDecisionLog:
      typeof stateRaw.lastDecisionLog === "string"
        ? stateRaw.lastDecisionLog
        : undefined,
  };
  const subjectKind = toText(row.subject_kind, "");
  const subjectId = toText(row.subject_id, "");
  const parsedMetadata =
    parseOptionalJsonRecord<Record<string, unknown>>(row.metadata_json) ?? {};
  if (
    typeof row.created_at === "string" &&
    typeof parsedMetadata.createdAtIso !== "string"
  ) {
    parsedMetadata.createdAtIso = row.created_at;
  }
  return {
    taskId: toText(row.id),
    kind: toText(row.kind) as ScheduledTask["kind"],
    promptInstructions: toText(row.prompt_instructions),
    contextRequest: parseOptionalJsonRecord<ScheduledTask["contextRequest"]>(
      row.context_request_json,
    ),
    trigger: parseJsonRecord(row.trigger_json) as ScheduledTask["trigger"],
    priority: toText(row.priority, "medium") as ScheduledTask["priority"],
    shouldFire: parseOptionalJsonRecord<ScheduledTask["shouldFire"]>(
      row.should_fire_json,
    ),
    completionCheck: parseOptionalJsonRecord<ScheduledTask["completionCheck"]>(
      row.completion_check_json,
    ),
    escalation: parseOptionalJsonRecord<ScheduledTask["escalation"]>(
      row.escalation_json,
    ),
    output: parseOptionalJsonRecord<ScheduledTask["output"]>(row.output_json),
    pipeline: parseOptionalJsonRecord<ScheduledTask["pipeline"]>(
      row.pipeline_json,
    ),
    subject:
      subjectKind && subjectId
        ? ({
            kind: subjectKind,
            id: subjectId,
          } as ScheduledTask["subject"])
        : undefined,
    idempotencyKey:
      typeof row.idempotency_key === "string" && row.idempotency_key.length > 0
        ? row.idempotency_key
        : undefined,
    respectsGlobalPause: toBoolean(row.respects_global_pause, true),
    state,
    source: toText(row.source, "user_chat") as ScheduledTask["source"],
    createdBy: toText(row.created_by, ""),
    ownerVisible: toBoolean(row.owner_visible, true),
    metadata: parsedMetadata,
    executionProfile:
      typeof row.execution_profile === "string"
        ? (row.execution_profile as ScheduledTask["executionProfile"])
        : undefined,
  };
}

export function parseScheduledTaskLogRow(
  row: Record<string, unknown>,
): ScheduledTaskLogEntry {
  return {
    logId: toText(row.id),
    taskId: toText(row.task_id),
    agentId: toText(row.agent_id),
    occurredAtIso: toText(row.occurred_at),
    transition: toText(row.transition) as ScheduledTaskLogEntry["transition"],
    reason: typeof row.reason === "string" ? row.reason : undefined,
    rolledUp: toBoolean(row.rolled_up, false),
    detail: parseOptionalJsonRecord<Record<string, unknown>>(row.detail_json),
  };
}

interface SchedulingSqlStoreBaseOptions {
  agentId: string;
}

export type SchedulingSqlStoreOptions = SchedulingSqlStoreBaseOptions &
  (
    | { executeSql: SchedulingSqlExecutor; runtime?: never }
    | { runtime: IAgentRuntime; executeSql?: never }
  );

function schedulingSqlExecutor(
  options: SchedulingSqlStoreOptions,
): SchedulingSqlExecutor {
  return typeof options.executeSql === "function"
    ? options.executeSql
    : createRuntimeSchedulingSqlExecutor(options.runtime);
}

export function createSchedulingSqlScheduledTaskStore(
  opts: SchedulingSqlStoreOptions,
): ScheduledTaskStore {
  const { agentId } = opts;
  const executeSql = schedulingSqlExecutor(opts);
  // Shared by `upsert` and `upsertIfStatus`. `guardStatus` narrows the
  // conflict-update to rows still showing that lifecycle status, so a stale
  // post-dispatch snapshot cannot overwrite a user verb that landed while the
  // dispatcher was in flight.
  const upsertStatement = (
    task: ScheduledTask,
    nextFireAtIso: string | null | undefined,
    guardStatus?: ScheduledTask["state"]["status"],
    returningId?: boolean,
  ): string => {
    const now = isoNow();
    const nextFireAtSql =
      nextFireAtIso === null ||
      nextFireAtIso === undefined ||
      nextFireAtIso.length === 0
        ? "NULL"
        : `${sqlQuote(nextFireAtIso)}::timestamptz`;
    return `INSERT INTO ${TASK_TABLE} (
          id, agent_id, kind, prompt_instructions, context_request_json,
          trigger_json, priority, should_fire_json, completion_check_json,
          escalation_json, output_json, pipeline_json, subject_kind, subject_id,
          idempotency_key, respects_global_pause, state_json, source,
          created_by, owner_visible, metadata_json, execution_profile,
          next_fire_at, created_at, updated_at
        ) VALUES (
          ${sqlQuote(task.taskId)},
          ${sqlQuote(agentId)},
          ${sqlQuote(task.kind)},
          ${sqlQuote(task.promptInstructions)},
          ${sqlText(task.contextRequest ? JSON.stringify(task.contextRequest) : null)},
          ${sqlJson(task.trigger)},
          ${sqlQuote(task.priority)},
          ${sqlText(task.shouldFire ? JSON.stringify(task.shouldFire) : null)},
          ${sqlText(task.completionCheck ? JSON.stringify(task.completionCheck) : null)},
          ${sqlText(task.escalation ? JSON.stringify(task.escalation) : null)},
          ${sqlText(task.output ? JSON.stringify(task.output) : null)},
          ${sqlText(task.pipeline ? JSON.stringify(task.pipeline) : null)},
          ${sqlText(task.subject?.kind ?? null)},
          ${sqlText(task.subject?.id ?? null)},
          ${sqlText(task.idempotencyKey ?? null)},
          ${sqlBoolean(task.respectsGlobalPause)},
          ${sqlJson(task.state)},
          ${sqlQuote(task.source)},
          ${sqlQuote(task.createdBy)},
          ${sqlBoolean(task.ownerVisible)},
          ${sqlJson(task.metadata ?? {})},
          ${sqlText(task.executionProfile ?? null)},
          ${nextFireAtSql},
          ${sqlQuote(now)},
          ${sqlQuote(now)}
        )
        ON CONFLICT (agent_id, id) DO UPDATE SET
          kind = EXCLUDED.kind,
          prompt_instructions = EXCLUDED.prompt_instructions,
          context_request_json = EXCLUDED.context_request_json,
          trigger_json = EXCLUDED.trigger_json,
          priority = EXCLUDED.priority,
          should_fire_json = EXCLUDED.should_fire_json,
          completion_check_json = EXCLUDED.completion_check_json,
          escalation_json = EXCLUDED.escalation_json,
          output_json = EXCLUDED.output_json,
          pipeline_json = EXCLUDED.pipeline_json,
          subject_kind = EXCLUDED.subject_kind,
          subject_id = EXCLUDED.subject_id,
          idempotency_key = EXCLUDED.idempotency_key,
          respects_global_pause = EXCLUDED.respects_global_pause,
          state_json = EXCLUDED.state_json,
          source = EXCLUDED.source,
          created_by = EXCLUDED.created_by,
          owner_visible = EXCLUDED.owner_visible,
          metadata_json = EXCLUDED.metadata_json,
          execution_profile = EXCLUDED.execution_profile,
          next_fire_at = EXCLUDED.next_fire_at,
          updated_at = ${sqlQuote(now)}
        WHERE ${TASK_TABLE}.transfer_status IS NULL${
          guardStatus === undefined
            ? ""
            : `\n          AND (${TASK_TABLE}.state_json::jsonb ->> 'status') = ${sqlQuote(guardStatus)}`
        }${returningId ? "\n        RETURNING id" : ""}`;
  };
  // `upsertIfStatus` must NOT resurrect a row a concurrent writer deleted.
  // Reusing the upsert here would take the INSERT branch on a missing row,
  // return it via RETURNING, and report a won CAS — the opposite of the
  // in-memory store, which returns false when the row is gone. Deletion is a
  // live path (deleteCodingAgentSchedule), so this is UPDATE-only: a missing
  // row matches nothing and the caller correctly learns it lost the race.
  const guardedUpdateStatement = (
    task: ScheduledTask,
    nextFireAtIso: string | null | undefined,
    guardStatus: ScheduledTask["state"]["status"],
  ): string => {
    const now = isoNow();
    const nextFireAtSql =
      nextFireAtIso === null ||
      nextFireAtIso === undefined ||
      nextFireAtIso.length === 0
        ? "NULL"
        : `${sqlQuote(nextFireAtIso)}::timestamptz`;
    return `UPDATE ${TASK_TABLE} SET
          kind = ${sqlQuote(task.kind)},
          prompt_instructions = ${sqlQuote(task.promptInstructions)},
          context_request_json = ${sqlText(task.contextRequest ? JSON.stringify(task.contextRequest) : null)},
          trigger_json = ${sqlJson(task.trigger)},
          priority = ${sqlQuote(task.priority)},
          should_fire_json = ${sqlText(task.shouldFire ? JSON.stringify(task.shouldFire) : null)},
          completion_check_json = ${sqlText(task.completionCheck ? JSON.stringify(task.completionCheck) : null)},
          escalation_json = ${sqlText(task.escalation ? JSON.stringify(task.escalation) : null)},
          output_json = ${sqlText(task.output ? JSON.stringify(task.output) : null)},
          pipeline_json = ${sqlText(task.pipeline ? JSON.stringify(task.pipeline) : null)},
          subject_kind = ${sqlText(task.subject?.kind ?? null)},
          subject_id = ${sqlText(task.subject?.id ?? null)},
          idempotency_key = ${sqlText(task.idempotencyKey ?? null)},
          respects_global_pause = ${sqlBoolean(task.respectsGlobalPause)},
          state_json = ${sqlJson(task.state)},
          source = ${sqlQuote(task.source)},
          created_by = ${sqlQuote(task.createdBy)},
          owner_visible = ${sqlBoolean(task.ownerVisible)},
          metadata_json = ${sqlJson(task.metadata ?? {})},
          execution_profile = ${sqlText(task.executionProfile ?? null)},
          next_fire_at = ${nextFireAtSql},
          updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(task.taskId)}
          AND transfer_status IS NULL
          AND (state_json::jsonb ->> 'status') = ${sqlQuote(guardStatus)}
        RETURNING id`;
  };
  return {
    async upsert(task: ScheduledTask, options?: ScheduledTaskUpsertOptions) {
      await executeSql(upsertStatement(task, options?.nextFireAtIso));
    },
    async upsertIfStatus(task, options) {
      const rows = await executeSql(
        guardedUpdateStatement(
          task,
          options.nextFireAtIso,
          options.expectedStatus,
        ),
      );
      // Zero rows means the row is gone, transferred, or no longer in the
      // expected status — all three are "a concurrent writer moved it", which
      // is exactly what the caller needs to know.
      return rows.length > 0;
    },
    async claimForFire(args: {
      taskId: string;
      firedAtIso: string;
      expected?: ScheduledTaskClaimExpectation;
      expectedMetadata?: NonNullable<ScheduledTask["metadata"]>;
    }): Promise<ScheduledTaskClaimResult> {
      const now = isoNow();
      const expected = args.expected;
      // Admission observes parseScheduledTaskRow's metadata, including its
      // createdAtIso projection when the raw metadata does not contain a string.
      const stateGuard = expected
        ? `AND (state_json::jsonb ->> 'status') = ${sqlQuote(expected.status)}
            AND ${
              expected.firedAtIso === null
                ? `(state_json::jsonb ->> 'firedAt') IS NULL`
                : `(state_json::jsonb ->> 'firedAt') = ${sqlQuote(expected.firedAtIso)}`
            }`
        : `AND (state_json::jsonb ->> 'status') = 'scheduled'`;
      const rows = await executeSql(
        `UPDATE ${TASK_TABLE}
            SET state_json = jsonb_set(
                                jsonb_set(
                                  state_json::jsonb,
                                  '{status}',
                                  '"fired"'::jsonb,
                                  true
                                ),
                                '{firedAt}',
                                to_jsonb(${sqlQuote(args.firedAtIso)}::text),
                                true
                              )::text,
                next_fire_at = NULL,
                updated_at = ${sqlQuote(now)},
                version = version + 1
          WHERE agent_id = ${sqlQuote(agentId)}
            AND id = ${sqlQuote(args.taskId)}
            AND transfer_status IS NULL
            ${
              args.expectedMetadata === undefined
                ? ""
                : `AND (CASE WHEN jsonb_typeof(metadata_json::jsonb->'createdAtIso') = 'string'
              THEN metadata_json::jsonb
              ELSE metadata_json::jsonb || jsonb_build_object('createdAtIso', created_at)
              END) = ${sqlJson(args.expectedMetadata)}::jsonb`
            }
            AND COALESCE(
              metadata_json::jsonb #>> '{sharedCutoverImport,status}',
              ''
            ) <> 'reserved'
            ${stateGuard}
          RETURNING *`,
      );
      const row = rows[0];
      if (!row) return { kind: "raced" };
      return { kind: "fired", task: parseScheduledTaskRow(row) };
    },
    async commitApply({ task, receiptKey, commit, nextFireAtIso }) {
      const now = isoNow();
      const nextFireAtSql =
        nextFireAtIso === null || nextFireAtIso.length === 0
          ? "NULL"
          : `${sqlQuote(nextFireAtIso)}::timestamptz`;
      // PostgreSQL re-evaluates this expression against the current row after
      // a concurrent updater releases its lock. The proposed metadata remains
      // authoritative for lifecycle changes, while the receipt map is merged
      // from that current row so distinct committed keys cannot erase one
      // another.
      const proposedMetadataSql = `${sqlJson(task.metadata ?? {})}::jsonb`;
      const proposedReceiptValueSql = `COALESCE(
        ${proposedMetadataSql} -> 'schedulingApplyReceipts' -> ${sqlQuote(receiptKey)},
        'true'::jsonb
      )`;
      const mergedMetadataSql = `jsonb_set(
        ${proposedMetadataSql},
        '{schedulingApplyReceipts}',
        COALESCE(
          metadata_json::jsonb -> 'schedulingApplyReceipts',
          '{}'::jsonb
        ) || jsonb_build_object(${sqlQuote(receiptKey)}, ${proposedReceiptValueSql}),
        true
      )::text`;
      const rows = await executeSql(
        `WITH updated_task AS (
          UPDATE ${TASK_TABLE}
             SET state_json = ${sqlJson(task.state)},
                 metadata_json = ${mergedMetadataSql},
                 next_fire_at = ${nextFireAtSql},
                 updated_at = ${sqlQuote(now)},
                 version = version + 1
           WHERE agent_id = ${sqlQuote(agentId)}
             AND id = ${sqlQuote(task.taskId)}
             AND transfer_status IS NULL
             AND NOT (
               COALESCE(
                 metadata_json::jsonb -> 'schedulingApplyReceipts',
                 '{}'::jsonb
               ) ? ${sqlQuote(receiptKey)}
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM ${LOG_TABLE}
                WHERE id = ${sqlQuote(commit.logId)}
             )
          RETURNING *
        ), inserted_log AS (
          INSERT INTO ${LOG_TABLE} (
            id, agent_id, task_id, occurred_at, transition, reason, rolled_up, detail_json
          )
          SELECT
            ${sqlQuote(commit.logId)},
            ${sqlQuote(commit.agentId)},
            ${sqlQuote(commit.taskId)},
            ${sqlQuote(commit.occurredAtIso)},
            ${sqlQuote(commit.transition)},
            ${sqlText(commit.reason ?? null)},
            ${sqlBoolean(false)},
            ${sqlText(commit.detail ? JSON.stringify(commit.detail) : null)}
          FROM updated_task
          RETURNING *
        )
        SELECT to_jsonb(updated_task) AS task_row,
               to_jsonb(inserted_log) AS log_row
          FROM updated_task
          JOIN inserted_log ON TRUE`,
      );
      const applied = rows[0];
      if (applied) {
        return {
          kind: "applied",
          task: parseScheduledTaskRow(parseJsonRecord(applied.task_row)),
          commit: parseScheduledTaskLogRow(parseJsonRecord(applied.log_row)),
        };
      }

      const replayRows = await executeSql(
        `SELECT to_jsonb(task_row) AS task_row,
                to_jsonb(log_row) AS log_row
           FROM ${TASK_TABLE} AS task_row
           JOIN ${LOG_TABLE} AS log_row
             ON log_row.id = ${sqlQuote(commit.logId)}
            AND log_row.agent_id = task_row.agent_id
            AND log_row.task_id = task_row.id
          WHERE task_row.agent_id = ${sqlQuote(agentId)}
            AND task_row.id = ${sqlQuote(task.taskId)}
            AND COALESCE(
              task_row.metadata_json::jsonb -> 'schedulingApplyReceipts',
              '{}'::jsonb
            ) ? ${sqlQuote(receiptKey)}
          LIMIT 1`,
      );
      const replayRow = replayRows[0];
      if (replayRow) {
        return {
          kind: "replayed",
          task: parseScheduledTaskRow(parseJsonRecord(replayRow.task_row)),
          commit: parseScheduledTaskLogRow(parseJsonRecord(replayRow.log_row)),
        };
      }
      throw new Error(
        `commitApply: task ${task.taskId} could not commit receipt ${receiptKey}`,
      );
    },
    async reserveApplyIntent({ task, intentKey }) {
      const now = isoNow();
      const proposedMetadataSql = `${sqlJson(task.metadata ?? {})}::jsonb`;
      const proposedIntentValueSql = `COALESCE(
        ${proposedMetadataSql} -> 'schedulingApplyIntents' -> ${sqlQuote(intentKey)},
        'true'::jsonb
      )`;
      const rows = await executeSql(
        `UPDATE ${TASK_TABLE}
            SET metadata_json = jsonb_set(
                                  metadata_json::jsonb,
                                  '{schedulingApplyIntents}',
                                  COALESCE(
                                    metadata_json::jsonb -> 'schedulingApplyIntents',
                                    '{}'::jsonb
                                  ) || jsonb_build_object(
                                    ${sqlQuote(intentKey)},
                                    ${proposedIntentValueSql}
                                  ),
                                  true
                                )::text,
                updated_at = ${sqlQuote(now)},
                version = version + 1
          WHERE agent_id = ${sqlQuote(agentId)}
            AND id = ${sqlQuote(task.taskId)}
            AND transfer_status IS NULL
            AND COALESCE(
              metadata_json::jsonb #>> '{sharedCutoverImport,status}',
              ''
            ) <> 'reserved'
            AND NOT (
              COALESCE(
                metadata_json::jsonb -> 'schedulingApplyIntents',
                '{}'::jsonb
              ) ? ${sqlQuote(intentKey)}
            )
          RETURNING *`,
      );
      const reserved = rows[0];
      if (reserved) {
        return { kind: "reserved", task: parseScheduledTaskRow(reserved) };
      }
      const replayRows = await executeSql(
        `SELECT *
           FROM ${TASK_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            AND id = ${sqlQuote(task.taskId)}
            AND COALESCE(
              metadata_json::jsonb -> 'schedulingApplyIntents',
              '{}'::jsonb
            ) ? ${sqlQuote(intentKey)}
          LIMIT 1`,
      );
      const replayed = replayRows[0];
      if (replayed) {
        return { kind: "replayed", task: parseScheduledTaskRow(replayed) };
      }
      throw new Error(
        `reserveApplyIntent: task ${task.taskId} could not reserve intent ${intentKey}`,
      );
    },
    async get(taskId: string) {
      const rows = await executeSql(
        `SELECT *
           FROM ${TASK_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            AND id = ${sqlQuote(taskId)}
          LIMIT 1`,
      );
      const row = rows[0];
      return row ? parseScheduledTaskRow(row) : null;
    },
    async findByIdempotencyKey(key: string) {
      const rows = await executeSql(
        `SELECT *
           FROM ${TASK_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            AND idempotency_key = ${sqlQuote(key)}
          LIMIT 1`,
      );
      const row = rows[0];
      return row ? parseScheduledTaskRow(row) : null;
    },
    async list(filter?: ScheduledTaskFilter) {
      const clauses: string[] = [`agent_id = ${sqlQuote(agentId)}`];
      if (filter?.kind) clauses.push(`kind = ${sqlQuote(filter.kind)}`);
      if (filter?.subject?.kind) {
        clauses.push(`subject_kind = ${sqlQuote(filter.subject.kind)}`);
      }
      if (filter?.subject?.id) {
        clauses.push(`subject_id = ${sqlQuote(filter.subject.id)}`);
      }
      if (filter?.source) clauses.push(`source = ${sqlQuote(filter.source)}`);
      if (filter?.ownerVisibleOnly) clauses.push("owner_visible = TRUE");
      if (filter?.status) {
        const statusList = (
          Array.isArray(filter.status) ? filter.status : [filter.status]
        )
          .filter((status) => status.length > 0)
          .map((status) => sqlQuote(status))
          .join(", ");
        if (statusList.length > 0) {
          clauses.push(`(state_json::jsonb ->> 'status') IN (${statusList})`);
        }
      }
      if (filter?.firedSince) {
        clauses.push(
          `(state_json::jsonb ->> 'firedAt') >= ${sqlQuote(filter.firedSince)}`,
        );
      }
      const rows = await executeSql(
        `SELECT *
           FROM ${TASK_TABLE}
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at ASC`,
      );
      return rows.map(parseScheduledTaskRow);
    },
    async delete(taskId: string) {
      await executeSql(
        `DELETE FROM ${TASK_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            AND id = ${sqlQuote(taskId)}`,
      );
      await executeSql(
        `DELETE FROM ${LOG_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            AND task_id = ${sqlQuote(taskId)}`,
      );
    },
  };
}

export function createSchedulingSqlScheduledTaskLogStore(
  opts: SchedulingSqlStoreOptions,
): ScheduledTaskLogStore {
  const { agentId } = opts;
  const executeSql = schedulingSqlExecutor(opts);
  return {
    async append(entry: ScheduledTaskLogEntry) {
      await executeSql(
        `INSERT INTO ${LOG_TABLE} (
          id, agent_id, task_id, occurred_at, transition, reason, rolled_up, detail_json
        ) VALUES (
          ${sqlQuote(entry.logId)},
          ${sqlQuote(entry.agentId)},
          ${sqlQuote(entry.taskId)},
          ${sqlQuote(entry.occurredAtIso)},
          ${sqlQuote(entry.transition)},
          ${sqlText(entry.reason ?? null)},
          ${sqlBoolean(entry.rolledUp)},
          ${sqlText(entry.detail ? JSON.stringify(entry.detail) : null)}
        )`,
      );
    },
    async list(args) {
      const clauses: string[] = [
        `agent_id = ${sqlQuote(agentId)}`,
        `task_id = ${sqlQuote(args.taskId)}`,
      ];
      if (args.sinceIso) {
        clauses.push(`occurred_at >= ${sqlQuote(args.sinceIso)}`);
      }
      if (args.untilIso) {
        clauses.push(`occurred_at < ${sqlQuote(args.untilIso)}`);
      }
      if (args.excludeRollups) clauses.push("rolled_up = FALSE");
      const limit =
        typeof args.limit === "number" && args.limit > 0
          ? `LIMIT ${sqlInteger(args.limit)}`
          : "";
      const rows = await executeSql(
        `SELECT *
           FROM ${LOG_TABLE}
          WHERE ${clauses.join(" AND ")}
          ORDER BY occurred_at ASC
          ${limit}`,
      );
      return rows.map(parseScheduledTaskLogRow);
    },
    async rollupOlderThan(args) {
      if (args.taskIds?.length === 0) return { rolledUp: 0, deletedRaw: 0 };
      const taskScope =
        args.taskIds === undefined
          ? ""
          : `AND task_id IN (${args.taskIds.map((id) => sqlQuote(id)).join(",")})`;
      const rows = await executeSql(
        `SELECT *
           FROM ${LOG_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            ${taskScope}
            AND rolled_up = FALSE
            AND transition <> 'scheduled'
            AND NOT (
              COALESCE(detail_json::jsonb, '{}'::jsonb) ? 'receiptKey'
            )
            AND occurred_at < ${sqlQuote(args.olderThanIso)}`,
      );
      if (rows.length === 0) return { rolledUp: 0, deletedRaw: 0 };
      const summary = new Map<
        string,
        {
          taskId: string;
          transition: string;
          dayIso: string;
          count: number;
          firstReason: string | null;
        }
      >();
      for (const row of rows) {
        const occurredAt = toText(row.occurred_at);
        const dayIso = occurredAt.slice(0, 10);
        const key = `${toText(row.task_id)}::${dayIso}::${toText(row.transition)}`;
        const existing = summary.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          summary.set(key, {
            taskId: toText(row.task_id),
            transition: toText(row.transition),
            dayIso,
            count: 1,
            firstReason: typeof row.reason === "string" ? row.reason : null,
          });
        }
      }
      await executeSql(
        `DELETE FROM ${LOG_TABLE}
          WHERE agent_id = ${sqlQuote(agentId)}
            ${taskScope}
            AND rolled_up = FALSE
            AND transition <> 'scheduled'
            AND NOT (
              COALESCE(detail_json::jsonb, '{}'::jsonb) ? 'receiptKey'
            )
            AND occurred_at < ${sqlQuote(args.olderThanIso)}`,
      );
      let counter = 0;
      for (const item of summary.values()) {
        counter += 1;
        const id = `rollup-${item.taskId}-${item.dayIso}-${item.transition}-${counter}`;
        await executeSql(
          `INSERT INTO ${LOG_TABLE} (
            id, agent_id, task_id, occurred_at, transition, reason, rolled_up, detail_json
          ) VALUES (
            ${sqlQuote(id)},
            ${sqlQuote(agentId)},
            ${sqlQuote(item.taskId)},
            ${sqlQuote(`${item.dayIso}T00:00:00.000Z`)},
            ${sqlQuote(item.transition)},
            ${sqlText(item.firstReason ?? null)},
            ${sqlBoolean(true)},
            ${sqlText(JSON.stringify({ rollupCount: item.count }))}
          )`,
        );
      }
      return { rolledUp: summary.size, deletedRaw: rows.length };
    },
  };
}
