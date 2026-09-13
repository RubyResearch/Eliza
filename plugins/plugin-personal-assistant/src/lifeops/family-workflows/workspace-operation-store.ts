/**
 * Serializes family operation admission against the workspace's durable deletion fence.
 * Claims contain identities only and have no expiry: elapsed time cannot prove that
 * an external request stopped. The deletion transaction must observe every claim
 * settled before fencing the workspace. The fence survives runtime restarts.
 */
import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlQuote,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const uploadId = z.string().regex(/^hagu_[0-9a-f-]{36}$/);
const operationTarget = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("family-packet-approval"),
      packetId: z.string().min(1),
      draftVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("family-scheduled-execution"),
      taskId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agreement-upload"),
      artifactId: z.string().regex(/^hag_[0-9a-f-]{36}$/),
      contentSha256: sha256,
    })
    .strict(),
  z.object({ kind: z.literal("agreement-upload-begin"), uploadId }).strict(),
  z
    .object({
      kind: z.literal("agreement-upload-chunk"),
      uploadId,
      index: z.number().int().nonnegative(),
      contentSha256: sha256,
    })
    .strict(),
  z
    .object({
      kind: z.literal("agreement-upload-commit"),
      uploadId,
      contentIdentity: sha256,
    })
    .strict(),
]);
export type FamilyWorkspaceOperationTarget = z.infer<typeof operationTarget>;

const operations = "app_lifeops.life_family_workspace_operations";
const lifecycle = "app_lifeops.life_family_workspace_state";
const schema = [
  "CREATE SCHEMA IF NOT EXISTS app_lifeops",
  `CREATE TABLE IF NOT EXISTS ${lifecycle} (
    agent_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoking', 'deleted')),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${operations} (
    agent_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    kind TEXT NOT NULL, started_at TEXT NOT NULL,
    target_json JSONB NOT NULL,
    PRIMARY KEY (agent_id, operation_id)
  )`,
] as const;

export async function ensureFamilyWorkspaceOperationStore(
  runtime: IAgentRuntime,
  agentId = runtime.agentId,
) {
  for (const statement of schema) await executeRawSql(runtime, statement);
  await executeRawSql(
    runtime,
    `INSERT INTO ${lifecycle} (agent_id,state,updated_at)
     VALUES (${sqlQuote(agentId)},'active',${sqlQuote(new Date().toISOString())})
     ON CONFLICT (agent_id) DO NOTHING`,
  );
}

export type FamilyWorkspaceState = "active" | "revoking" | "deleted";

export function assertFamilyWorkspaceActive(state: FamilyWorkspaceState): void {
  if (state !== "active")
    throw new ElizaError(
      "[FamilyWorkspace] Deletion has fenced new family work",
      { code: "FAMILY_WORKSPACE_FENCED" },
    );
}

/** Inspect state and mutate canonical stores under a shared, ordered lock inventory. */
export async function withFamilyWorkspaceStateTransaction<T>(
  runtime: IAgentRuntime,
  tables: readonly string[],
  mutate: (tx: TransactionalDb, state: FamilyWorkspaceState) => Promise<T>,
  options: {
    agentId?: string;
    lockMode?: "ROW EXCLUSIVE" | "SHARE ROW EXCLUSIVE";
  } = {},
): Promise<T> {
  const names = z
    .array(z.string().regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/))
    .parse(tables);
  const agentId = options.agentId ?? runtime.agentId;
  const lockMode = z
    .enum(["ROW EXCLUSIVE", "SHARE ROW EXCLUSIVE"])
    .parse(options.lockMode ?? "ROW EXCLUSIVE");
  await ensureFamilyWorkspaceOperationStore(runtime, agentId);
  return withTransaction(runtime, async (tx) => {
    const locked = [...new Set([...names, lifecycle])].sort();
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${locked.join(", ")} IN ${lockMode} MODE`,
    );
    const rows = await executeRawSqlTx(
      tx,
      `SELECT state FROM ${lifecycle} WHERE agent_id=${sqlQuote(agentId)} FOR SHARE`,
    );
    if (rows.length !== 1)
      throw new ElizaError(
        "[FamilyWorkspace] Workspace lifecycle state is unavailable",
        { code: "FAMILY_WORKSPACE_UNAVAILABLE" },
      );
    return mutate(
      tx,
      z.enum(["active", "revoking", "deleted"]).parse(rows[0].state),
    );
  });
}

/**
 * Run database-only family mutations while holding admission through commit.
 * Callers supply every table touched by their callback, including audit writes,
 * so the sorted table-lock order matches the reviewed deletion transaction.
 */
export async function withActiveFamilyWorkspaceTransaction<T>(
  runtime: IAgentRuntime,
  tables: readonly string[],
  mutate: (tx: TransactionalDb) => Promise<T>,
  agentId = runtime.agentId,
): Promise<T> {
  return withFamilyWorkspaceStateTransaction(
    runtime,
    tables,
    (tx, state) => {
      assertFamilyWorkspaceActive(state);
      return mutate(tx);
    },
    { agentId },
  );
}

/** Caller holds the operation and lifecycle table locks in canonical order. */
export async function beginFamilyWorkspaceOperationTx(
  tx: TransactionalDb,
  agentId: string,
  target: FamilyWorkspaceOperationTarget,
): Promise<string> {
  const identity = operationTarget.parse(target);
  const rows = await executeRawSqlTx(
    tx,
    `SELECT state FROM ${lifecycle} WHERE agent_id=${sqlQuote(agentId)} FOR UPDATE`,
  );
  if (rows.length !== 1 || rows[0].state !== "active")
    throw new ElizaError(
      "[FamilyWorkspace] Deletion has fenced new family work",
      {
        code: "FAMILY_WORKSPACE_FENCED",
      },
    );
  if ("uploadId" in identity) {
    const unfinished = await executeRawSqlTx(
      tx,
      `SELECT operation_id FROM ${operations} WHERE agent_id=${sqlQuote(agentId)} AND target_json->>'uploadId'=${sqlQuote(identity.uploadId)}`,
    );
    if (unfinished.length)
      throw new ElizaError(
        "[FamilyWorkspace] This upload has unfinished work; wait for it or reconcile its claim before retrying",
        {
          code: "FAMILY_OPERATION_UNSETTLED",
          context: {
            uploadId: identity.uploadId,
            operationIds: unfinished.map((row) =>
              z.string().parse(row.operation_id),
            ),
          },
        },
      );
  }
  const id = randomUUID();
  await executeRawSqlTx(
    tx,
    `INSERT INTO ${operations} (agent_id,operation_id,kind,started_at,target_json)
     VALUES (${sqlQuote(agentId)},${sqlQuote(id)},${sqlQuote(identity.kind)},${sqlQuote(new Date().toISOString())},${sqlQuote(JSON.stringify(identity))}::jsonb)`,
  );
  return id;
}

export async function beginFamilyWorkspaceOperation(
  runtime: IAgentRuntime,
  target: FamilyWorkspaceOperationTarget,
  agentId = runtime.agentId,
): Promise<string> {
  await ensureFamilyWorkspaceOperationStore(runtime, agentId);
  return withTransaction(runtime, async (tx) => {
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${operations}, ${lifecycle} IN ROW EXCLUSIVE MODE`,
    );
    return beginFamilyWorkspaceOperationTx(tx, agentId, target);
  });
}

/** Settle only after the operation and any required compensation have finished. */
export async function settleFamilyWorkspaceOperation(
  runtime: IAgentRuntime,
  operationId: string,
  agentId = runtime.agentId,
): Promise<void> {
  const id = z.uuid().parse(operationId);
  const rows = await executeRawSql(
    runtime,
    `DELETE FROM ${operations} WHERE agent_id=${sqlQuote(agentId)}
     AND operation_id=${sqlQuote(id)} RETURNING operation_id`,
  );
  if (rows.length !== 1)
    throw new ElizaError(
      "[FamilyWorkspace] Operation settlement requires reconciliation",
      {
        code: "FAMILY_OPERATION_SETTLEMENT_UNKNOWN",
        context: { operationId: id },
      },
    );
}

/** Called inside the reviewed deletion transaction, never from an unguarded route. */
export async function fenceFamilyWorkspace(
  tx: TransactionalDb,
  agentId: string,
): Promise<void> {
  await executeRawSqlTx(
    tx,
    `LOCK TABLE ${operations}, ${lifecycle} IN SHARE ROW EXCLUSIVE MODE`,
  );
  const active = await executeRawSqlTx(
    tx,
    `SELECT operation_id FROM ${operations} WHERE agent_id=${sqlQuote(agentId)}`,
  );
  if (active.length)
    throw new ElizaError(
      "[FamilyWorkspace] Settle or reconcile active operations before deletion",
      {
        code: "FAMILY_DELETION_WORK_UNSETTLED",
        context: {
          operationIds: active.map((row) => z.string().parse(row.operation_id)),
        },
      },
    );
  const rows = await executeRawSqlTx(
    tx,
    `UPDATE ${lifecycle} SET state='revoking',updated_at=${sqlQuote(new Date().toISOString())}
     WHERE agent_id=${sqlQuote(agentId)} AND state='active' RETURNING agent_id`,
  );
  if (rows.length !== 1)
    throw new ElizaError(
      "[FamilyWorkspace] The workspace is already fenced or unavailable",
      {
        code: "FAMILY_WORKSPACE_FENCED",
      },
    );
}
