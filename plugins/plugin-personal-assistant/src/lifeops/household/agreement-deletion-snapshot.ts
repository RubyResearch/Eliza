/**
 * Binds a reviewed agreement-family dependency snapshot to a database transaction.
 * The complete immutable version family is selected before review. Table locks
 * prevent later versions, grants, pins, and review decisions from racing the
 * comparison and its caller's transactional revocation. Typed packet references
 * include every version/draft/approval of a dependent packet; unrelated packets
 * and dispatch ownership tokens are excluded. Missing stores block revocation. This is one component
 * of workspace deletion; it does not delete documents, files, or provider data.
 */
import { createHash } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { z } from "zod";
import {
  executeRawSqlTx,
  sqlQuote,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";

const selectionSchema = z.strictObject({
  householdId: z.string().trim().min(1),
  agreementKey: z.string().trim().min(1),
});
export type AgreementDeletionSelection = z.infer<typeof selectionSchema>;

const categories = [
  "versions",
  "obligations",
  "pins",
  "resourceGrants",
  "audit",
  "householdGrants",
  "packets",
  "drafts",
  "packetApprovals",
  "approvals",
] as const;
const recordSchema = z.strictObject({
  kind: z.enum(categories),
  payload: z.string(),
});

export interface AgreementDeletionSnapshot {
  readonly selection: AgreementDeletionSelection;
  readonly sha256: string;
  readonly unavailable: readonly string[];
  /** Complete persisted JSON records. These owner-private values are not audit metadata. */
  readonly records: ReadonlyArray<{
    kind: (typeof categories)[number];
    payload: string;
  }>;
}

const tables = [
  "life_household_agreement_artifacts",
  "life_household_agreement_obligations",
  "life_household_knowledge_pins",
  "life_household_knowledge_grants",
  "life_audit_events",
  "life_household_access_grants",
] as const;

const packetSources = [
  { kind: "packets", table: "app_lifeops.life_family_packets" },
  { kind: "drafts", table: "app_lifeops.life_family_packet_drafts" },
  {
    kind: "packetApprovals",
    table: "app_lifeops.life_family_packet_approvals",
  },
  { kind: "approvals", table: "approval_requests" },
] as const;

async function packetAvailability(tx: TransactionalDb) {
  const rows = await executeRawSqlTx(
    tx,
    packetSources
      .map(
        (source) =>
          `SELECT ${sqlQuote(source.kind)} AS kind, to_regclass(${sqlQuote(source.table)}) IS NOT NULL AS available`,
      )
      .join(" UNION ALL "),
  );
  return packetSources
    .filter(
      (source) =>
        !rows.some((row) => row.kind === source.kind && row.available === true),
    )
    .map((source) => source.kind);
}

const storedPacketSchema = z.object({
  claims: z.array(
    z.object({
      agreementArtifactId: z.string().nullish(),
      obligationApprovalId: z.string().nullish(),
      provenance: z.array(
        z.object({
          source: z.enum([
            "household",
            "calendar",
            "school",
            "agreement",
            "knowledge",
          ]),
          sourceId: z.string(),
        }),
      ),
    }),
  ),
});

const storedRecordSchema = z.record(z.string(), z.json());

function storedObject(payload: string): z.infer<typeof storedRecordSchema> {
  try {
    return storedRecordSchema.parse(JSON.parse(payload));
  } catch (cause) {
    // error-policy:J2 Invalid stored dependencies cannot authorize partial deletion.
    throw new ElizaError("[AgreementDeletion] A dependency record is invalid", {
      code: "AGREEMENT_DELETION_SNAPSHOT_INVALID",
      cause,
    });
  }
}

function requireOwner(ownerEntityId: string): void {
  if (ownerEntityId !== SELF_ENTITY_ID)
    throw new ElizaError(
      "[AgreementDeletion] Only the owner may review deletion dependencies",
      {
        code: "AGREEMENT_ACCESS_DENIED",
      },
    );
}

function storedPacket(value: z.infer<typeof storedRecordSchema>[string]) {
  try {
    return storedPacketSchema.parse(JSON.parse(z.string().parse(value)));
  } catch (cause) {
    // error-policy:J2 Unknown packet provenance must not appear unrelated.
    throw new ElizaError(
      "[AgreementDeletion] Packet provenance is invalid; repair it before deletion",
      {
        code: "AGREEMENT_DELETION_SNAPSHOT_INVALID",
        cause,
      },
    );
  }
}

async function readSnapshot(
  tx: TransactionalDb,
  agentId: string,
  selection: AgreementDeletionSelection,
): Promise<AgreementDeletionSnapshot> {
  const agent = `agent_id = ${sqlQuote(agentId)}`;
  const versions = `SELECT id FROM app_lifeops.life_household_agreement_artifacts
    WHERE ${agent} AND household_id = ${sqlQuote(selection.householdId)}
    AND agreement_key = ${sqlQuote(selection.agreementKey)}`;
  const predicates = [
    `id IN (${versions})`,
    `artifact_id IN (${versions})`,
    `artifact_id IN (${versions})`,
    `artifact_id IN (${versions})`,
    `owner_type = 'parenting_agreement' AND owner_id IN (${versions})`,
    `id IN (SELECT household_grant_id FROM app_lifeops.life_household_knowledge_grants WHERE ${agent} AND artifact_id IN (${versions}))`,
  ];
  const unavailable = await packetAvailability(tx);
  const queries = tables.map(
    (table, index) =>
      `SELECT ${sqlQuote(categories[index])} AS kind, to_jsonb(record)::text AS payload
     FROM app_lifeops.${table} AS record WHERE ${agent} AND ${predicates[index]}`,
  );
  for (const source of packetSources) {
    if (unavailable.includes(source.kind)) continue;
    if (source.kind === "approvals") {
      if (unavailable.includes("packetApprovals")) continue;
      // Dispatch ownership tokens are excluded from the owner-private preview.
      queries.push(`SELECT 'approvals' AS kind, to_jsonb(record)::text AS payload FROM (
        SELECT id,state,requested_by,subject_user_id,action,payload,channel,reason,expires_at,resolved_at,resolved_by,resolution_reason,execution_provider,dispatch_started_at,provider_receipt,execution_error,reconciliation_resolved_at,reconciliation_reason,created_at,updated_at
        FROM approval_requests WHERE ${agent} AND id::text IN (
          SELECT approval_id FROM app_lifeops.life_family_packet_approvals WHERE ${agent}
        )) AS record`);
    } else {
      queries.push(
        `SELECT ${sqlQuote(source.kind)} AS kind, to_jsonb(record)::text AS payload FROM ${source.table} AS record WHERE ${agent}`,
      );
    }
  }
  const raw = await executeRawSqlTx(tx, queries.join(" UNION ALL "));
  const captured = raw.map((row) => recordSchema.parse(row));
  const versionIds = new Set(
    captured
      .filter((row) => row.kind === "versions")
      .map((row) => z.string().parse(storedObject(row.payload).id)),
  );
  const obligationIds = new Set(
    captured
      .filter((row) => row.kind === "obligations")
      .map((row) => z.string().parse(storedObject(row.payload).id)),
  );
  const packetIds = new Set<string>();
  for (const row of captured.filter((row) => row.kind === "packets")) {
    const stored = storedObject(row.payload);
    // Parse every scoped packet before choosing dependencies. Corrupt or
    // untyped provenance cannot silently masquerade as an unrelated packet.
    const packet = storedPacket(stored.packet_json);
    if (
      packet.claims.some(
        (claim) =>
          (claim.agreementArtifactId != null &&
            versionIds.has(claim.agreementArtifactId)) ||
          (claim.obligationApprovalId != null &&
            obligationIds.has(claim.obligationApprovalId)) ||
          claim.provenance.some(
            (source) =>
              (source.source === "agreement" ||
                source.source === "knowledge") &&
              (versionIds.has(source.sourceId) ||
                obligationIds.has(source.sourceId)),
          ),
      )
    )
      packetIds.add(z.string().parse(stored.packet_id));
  }
  const approvalIds = new Set(
    captured
      .filter((row) => row.kind === "packetApprovals")
      .map((row) => storedObject(row.payload))
      .filter((row) => packetIds.has(z.string().parse(row.packet_id)))
      .map((row) => z.string().parse(row.approval_id)),
  );
  const records = captured
    .filter((row) => {
      if (
        row.kind === "packets" ||
        row.kind === "drafts" ||
        row.kind === "packetApprovals"
      )
        return packetIds.has(
          z.string().parse(storedObject(row.payload).packet_id),
        );
      if (row.kind === "approvals")
        return approvalIds.has(z.string().parse(storedObject(row.payload).id));
      return true;
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.payload.localeCompare(b.payload),
    );
  if (!records.some((record) => record.kind === "versions"))
    throw new ElizaError(
      "[AgreementDeletion] The selected agreement family no longer exists",
      {
        code: "AGREEMENT_ARTIFACT_NOT_FOUND",
      },
    );
  const sha256 = createHash("sha256")
    .update(JSON.stringify({ agentId, selection, records, unavailable }))
    .digest("hex");
  return { selection, sha256, records, unavailable };
}

export async function previewAgreementDeletion(
  runtime: IAgentRuntime,
  input: { ownerEntityId: string; selection: AgreementDeletionSelection },
): Promise<AgreementDeletionSnapshot> {
  requireOwner(input.ownerEntityId);
  const selection = selectionSchema.parse(input.selection);
  // All records come from one statement snapshot; preview never mutates state.
  return withTransaction(runtime, (tx) =>
    readSnapshot(tx, runtime.agentId, selection),
  );
}

/** Compare under write-excluding locks and keep those locks through revocation. */
export async function withReviewedAgreementDeletion<T>(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    selection: AgreementDeletionSelection;
    expectedSha256: string;
  },
  revoke: (
    tx: TransactionalDb,
    snapshot: AgreementDeletionSnapshot,
  ) => Promise<T>,
): Promise<T> {
  requireOwner(input.ownerEntityId);
  const selection = selectionSchema.parse(input.selection);
  const expected = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.expectedSha256);
  return withTransaction(runtime, async (tx) => {
    const unavailable = await packetAvailability(tx);
    if (unavailable.length)
      throw new ElizaError(
        "[AgreementDeletion] Initialize and review the missing packet dependency stores before deletion",
        {
          code: "AGREEMENT_DELETION_DEPENDENCIES_UNAVAILABLE",
          context: { unavailable },
        },
      );
    // Every writer acquires a conflicting PostgreSQL table lock, including an
    // insertion that has no pre-existing row for SELECT FOR UPDATE to lock.
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${[...tables.map((table) => `app_lifeops.${table}`), ...packetSources.map((source) => source.table)].join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const snapshot = await readSnapshot(tx, runtime.agentId, selection);
    if (snapshot.sha256 !== expected)
      throw new ElizaError(
        "[AgreementDeletion] Dependencies changed; review a new deletion preview",
        {
          code: "AGREEMENT_DELETION_PREVIEW_STALE",
        },
      );
    return revoke(tx, snapshot);
  });
}
