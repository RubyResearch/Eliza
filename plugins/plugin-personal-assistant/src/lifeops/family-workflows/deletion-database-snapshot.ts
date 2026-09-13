/**
 * Captures the family workspace's database dependencies for deletion review.
 * Full rows contribute to fingerprints; returned identities contain only an
 * explicit projection, excluding dispatch and transfer credentials. Canonical
 * document fragments and structural scheduled tasks are included. Generic
 * calendar cards remain unclassified rather than being silently deleted.
 * This guard owns database comparison, not file, backup, or provider deletion.
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
import { ensureFamilyWorkflowRunStore } from "./run-store.js";
import {
  FAMILY_SCHEDULING_REFERENCE_TABLES,
  familyApprovalIdsSql,
  familyScheduledTaskPredicate,
} from "./scheduled-identity.js";
import { ensureFamilyWorkspaceOperationStore } from "./workspace-operation-store.js";

interface DependencySource {
  kind: string;
  table: string;
  fields: readonly string[];
  classification?: "referenced" | "mixed" | "unclassified";
  predicate?: string;
  unsettledPredicate?: string;
  requires?: readonly string[];
}

const agreementTable = "app_lifeops.life_household_agreement_artifacts";
const taskTable = "app_scheduling.life_scheduled_tasks";
const packetApprovalTable = "app_lifeops.life_family_packet_approvals";
const householdApprovalTable = "app_lifeops.life_household_proposal_approvals";
const familyTask = familyScheduledTaskPredicate("$AGENT");
const familyDocument = `(metadata->>'source' = 'lifeops.parenting-agreement' OR id::text IN
  (SELECT document_id FROM ${agreementTable} WHERE agent_id = $AGENT))`;

const sources: readonly DependencySource[] = [
  {
    kind: "agreementUploads",
    table: "cache",
    fields: ["key"],
    predicate: "key LIKE 'lifeops:agreement-upload:v1:%'",
    unsettledPredicate:
      "(value->>'status') IS DISTINCT FROM 'uploading' AND (value->>'status') IS DISTINCT FROM 'complete'",
  },
  {
    kind: "workspaceLifecycle",
    table: "app_lifeops.life_family_workspace_state",
    fields: ["agent_id", "state", "updated_at"],
  },
  {
    kind: "workspaceOperations",
    table: "app_lifeops.life_family_workspace_operations",
    fields: ["operation_id", "kind", "started_at", "target_json"],
    unsettledPredicate: "true",
  },
  {
    kind: "agreements",
    table: agreementTable,
    fields: [
      "id",
      "household_id",
      "agreement_key",
      "version",
      "title",
      "document_id",
      "media_file_name",
    ],
  },
  {
    kind: "obligations",
    table: "app_lifeops.life_household_agreement_obligations",
    fields: ["id", "artifact_id"],
  },
  {
    kind: "pins",
    table: "app_lifeops.life_household_knowledge_pins",
    fields: ["id", "artifact_id"],
  },
  {
    kind: "resourceGrants",
    table: "app_lifeops.life_household_knowledge_grants",
    fields: ["id", "artifact_id"],
  },
  {
    kind: "householdGrants",
    table: "app_lifeops.life_household_access_grants",
    fields: ["id", "household_id", "principal_entity_id"],
  },
  {
    kind: "grantWarnings",
    table: "app_lifeops.life_household_grant_expiry_warning_claims",
    fields: ["agent_id", "grant_id"],
  },
  {
    kind: "coordinationHeads",
    table: "app_lifeops.life_household_coordination_heads",
    fields: ["id", "household_id", "coordination_id"],
  },
  {
    kind: "proposals",
    table: "app_lifeops.life_household_schedule_proposals",
    fields: ["id", "household_id", "proposal_id", "version"],
  },
  {
    kind: "proposalApprovals",
    table: householdApprovalTable,
    fields: ["id", "proposal_id", "approval_request_id"],
  },
  {
    kind: "inboundApprovalReceipts",
    table: "app_lifeops.life_household_inbound_approval_receipts",
    fields: ["id", "proposal_id", "approval_request_id"],
  },
  {
    kind: "scheduleAgreements",
    table: "app_lifeops.life_household_schedule_agreements",
    fields: ["id", "household_id", "coordination_id", "version"],
  },
  {
    kind: "relationships",
    classification: "mixed",
    table: "app_lifeops.life_relationships_v2",
    fields: [
      "relationship_id",
      "from_entity_id",
      "to_entity_id",
      "type",
      "status",
    ],
    predicate:
      "(type = 'custody_authority' OR metadata_json::jsonb ? 'householdRole')",
  },
  {
    kind: "packets",
    table: "app_lifeops.life_family_packets",
    fields: ["packet_id", "period_key", "internal_version"],
  },
  {
    kind: "drafts",
    table: "app_lifeops.life_family_packet_drafts",
    fields: ["packet_id", "internal_version", "draft_version"],
  },
  {
    kind: "packetApprovals",
    table: packetApprovalTable,
    fields: ["packet_id", "draft_version", "approval_id"],
  },
  {
    kind: "workflowRuns",
    unsettledPredicate: "state = 'running' OR lease_token IS NOT NULL",
    table: "app_lifeops.life_family_workflow_runs",
    fields: ["period_key", "run_id", "state"],
  },
  {
    kind: "schoolSources",
    unsettledPredicate: "lease_token IS NOT NULL",
    table: "app_lifeops.life_school_calendar_sources",
    fields: ["source_id", "last_content_sha256", "last_media_url"],
  },
  {
    kind: "schoolRuns",
    unsettledPredicate:
      "state IN ('running', 'applying') OR apply_lease_token IS NOT NULL",
    table: "app_lifeops.life_school_calendar_runs",
    fields: ["run_id", "source_id", "state", "content_sha256", "media_url"],
  },
  {
    kind: "schoolEvents",
    table: "app_lifeops.life_school_calendar_events",
    fields: ["source_id", "event_key", "provider_event_id", "active"],
  },
  {
    kind: "schoolMutations",
    unsettledPredicate: "state = 'executing' OR lease_token IS NOT NULL",
    table: "app_lifeops.life_school_calendar_apply_operations",
    fields: ["run_id", "operation_index", "event_key", "kind", "state"],
  },
  {
    kind: "scheduledTasks",
    requires: [...FAMILY_SCHEDULING_REFERENCE_TABLES],
    table: taskTable,
    fields: ["id", "kind", "version", "next_fire_at"],
    predicate: familyTask,
  },
  {
    kind: "scheduledTaskHistory",
    table: "app_scheduling.life_scheduled_task_log",
    fields: ["id", "task_id", "transition", "occurred_at"],
    requires: [taskTable, ...FAMILY_SCHEDULING_REFERENCE_TABLES],
    predicate: `task_id IN (SELECT id FROM ${taskTable} WHERE agent_id = $AGENT AND ${familyTask})`,
  },
  {
    kind: "approvals",
    unsettledPredicate: "state IN ('executing', 'reconciliation_required')",
    table: "approval_requests",
    fields: ["id", "state", "action", "channel", "expires_at"],
    requires: [packetApprovalTable, householdApprovalTable],
    predicate: `id::text IN (${familyApprovalIdsSql("$AGENT")})`,
  },
  {
    kind: "documents",
    table: "memories",
    fields: ["id", "type"],
    requires: [agreementTable],
    predicate: `type = 'documents' AND metadata->>'type' IS DISTINCT FROM 'fragment' AND ${familyDocument}`,
  },
  {
    kind: "documentFragments",
    table: "memories",
    fields: ["id", "type"],
    requires: [agreementTable],
    predicate: `type IN ('documents', 'document_fragments') AND metadata->>'type' = 'fragment' AND metadata->>'documentId' IN (SELECT id::text FROM memories WHERE agent_id::text = $AGENT AND type = 'documents' AND ${familyDocument})`,
  },
  {
    kind: "referencedCalendarEvents",
    classification: "referenced",
    table: "app_lifeops.life_calendar_events",
    fields: [
      "id",
      "provider",
      "calendar_id",
      "external_event_id",
      "title",
      "start_at",
      "end_at",
    ],
    requires: [
      "app_lifeops.life_family_packets",
      "app_lifeops.life_school_calendar_events",
      "app_lifeops.life_school_calendar_sources",
    ],
    predicate: `(id IN (
      SELECT provenance->>'sourceId' FROM app_lifeops.life_family_packets packet
      CROSS JOIN LATERAL jsonb_array_elements(packet.packet_json::jsonb->'claims') claim
      CROSS JOIN LATERAL jsonb_array_elements(claim->'provenance') provenance
      WHERE packet.agent_id = $AGENT AND provenance->>'source' = 'calendar'
    ) OR EXISTS (
      SELECT 1 FROM app_lifeops.life_school_calendar_events event
      JOIN app_lifeops.life_school_calendar_sources source ON source.agent_id = event.agent_id AND source.source_id = event.source_id
      WHERE event.agent_id = $AGENT AND event.provider_event_id = record.external_event_id
      AND source.config_json::jsonb->>'targetCalendarId' = record.calendar_id
      AND source.config_json::jsonb->>'targetGrantId' = record.grant_id
    ))`,
  },
  {
    kind: "audit",
    table: "app_lifeops.life_audit_events",
    fields: ["id", "event_type", "owner_type", "owner_id", "created_at"],
    predicate:
      "(owner_type = 'parenting_agreement' OR event_type LIKE 'household\\_%' ESCAPE '\\' OR event_type LIKE 'family\\_%' ESCAPE '\\' OR event_type LIKE 'school_calendar\\_%' ESCAPE '\\')",
  },
  {
    kind: "unclassifiedCalendarCards",
    classification: "unclassified",
    table: "app_lifeops.life_calendar_card_access",
    fields: ["card_id", "recipient_entity_id", "expires_at", "revoked_at"],
  },
];

const rowSchema = z.record(z.string(), z.json());
export interface FamilyDeletionDatabaseSnapshot {
  readonly agentId: string;
  readonly sha256: string;
  readonly unavailable: readonly string[];
  readonly records: ReadonlyArray<{
    kind: string;
    classification: "owned" | "referenced" | "mixed" | "unclassified";
    unsettled: boolean;
    sha256: string;
    identity: z.infer<typeof rowSchema>;
  }>;
}

function requireOwner(ownerEntityId: string) {
  if (ownerEntityId !== SELF_ENTITY_ID)
    throw new ElizaError(
      "[FamilyDeletion] Only the owner may review workspace deletion",
      { code: "FAMILY_DELETION_ACCESS_DENIED" },
    );
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function availability(tx: TransactionalDb) {
  const tables = [
    ...new Set(
      sources.flatMap((source) => [source.table, ...(source.requires ?? [])]),
    ),
  ];
  const rows = await executeRawSqlTx(
    tx,
    tables
      .map(
        (table) =>
          `SELECT ${sqlQuote(table)} AS name, to_regclass(${sqlQuote(table)}) IS NOT NULL AS available`,
      )
      .join(" UNION ALL "),
  );
  return new Set(
    rows
      .filter((row) => row.available === true)
      .map((row) => z.string().parse(row.name)),
  );
}

async function capture(
  tx: TransactionalDb,
  agentId: string,
  available: ReadonlySet<string>,
): Promise<FamilyDeletionDatabaseSnapshot> {
  const present = sources.filter(
    (source) =>
      available.has(source.table) &&
      (source.requires ?? []).every((table) => available.has(table)),
  );
  const unavailable = sources
    .filter((source) => !present.includes(source))
    .map((source) => source.kind)
    .sort();
  const queries = present.map(
    (
      source,
    ) => `SELECT ${sqlQuote(source.kind)} AS kind, to_jsonb(record)::text AS payload, (${source.unsettledPredicate ?? "false"}) AS unsettled
    FROM ${source.table} AS record WHERE agent_id::text = ${sqlQuote(agentId)}
    ${source.predicate ? `AND (${source.predicate.replaceAll("$AGENT", sqlQuote(agentId))})` : ""}`,
  );
  const rows = queries.length
    ? await executeRawSqlTx(tx, queries.join(" UNION ALL "))
    : [];
  const records = rows
    .map((row) => {
      const source = sources.find((candidate) => candidate.kind === row.kind);
      if (!source)
        throw new ElizaError("[FamilyDeletion] Unknown dependency category", {
          code: "FAMILY_DELETION_RECORD_INVALID",
        });
      const payload = z.string().parse(row.payload);
      let stored: z.infer<typeof rowSchema>;
      try {
        stored = rowSchema.parse(JSON.parse(payload));
      } catch (cause) {
        // error-policy:J2 Invalid stored data cannot authorize incomplete deletion.
        throw new ElizaError(
          "[FamilyDeletion] A stored dependency is invalid",
          {
            code: "FAMILY_DELETION_RECORD_INVALID",
            context: { kind: source.kind },
            cause,
          },
        );
      }
      const identity: z.infer<typeof rowSchema> = {};
      for (const field of source.fields) {
        const value = stored[field];
        if (value === undefined)
          throw new ElizaError(
            "[FamilyDeletion] Dependency identity is incomplete",
            {
              code: "FAMILY_DELETION_RECORD_INVALID",
              context: { kind: source.kind, field },
            },
          );
        identity[field] = value;
      }
      return {
        kind: source.kind,
        classification: source.classification ?? ("owned" as const),
        identity,
        unsettled: z.boolean().parse(row.unsettled),
        sha256: digest(payload),
      };
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.sha256.localeCompare(b.sha256),
    );
  return {
    agentId,
    records,
    unavailable,
    sha256: digest(JSON.stringify({ agentId, records, unavailable })),
  };
}

export async function previewFamilyDeletionDatabase(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<FamilyDeletionDatabaseSnapshot> {
  requireOwner(ownerEntityId);
  // An agent that has never run its monthly task still has a deletable workspace.
  await ensureFamilyWorkflowRunStore(runtime);
  await ensureFamilyWorkspaceOperationStore(runtime);
  return withTransaction(runtime, async (tx) =>
    capture(tx, runtime.agentId, await availability(tx)),
  );
}

/** Hold all database dependency locks through the caller's transactional revocation. */
export async function withReviewedFamilyDeletionDatabase<T>(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    expectedSha256: string;
  },
  revoke: (
    tx: TransactionalDb,
    snapshot: FamilyDeletionDatabaseSnapshot,
  ) => Promise<T>,
): Promise<T> {
  requireOwner(input.ownerEntityId);
  const expected = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.expectedSha256);
  return withTransaction(runtime, async (tx) => {
    const available = await availability(tx);
    const missing = sources.filter(
      (source) =>
        !available.has(source.table) ||
        !(source.requires ?? []).every((table) => available.has(table)),
    );
    if (missing.length)
      throw new ElizaError(
        "[FamilyDeletion] Initialize the missing dependency stores before deletion review",
        {
          code: "FAMILY_DELETION_DEPENDENCIES_UNAVAILABLE",
          context: { unavailable: missing.map((source) => source.kind) },
        },
      );
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${[...new Set(sources.map((source) => source.table))].sort().join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const snapshot = await capture(tx, runtime.agentId, available);
    if (snapshot.sha256 !== expected)
      throw new ElizaError(
        "[FamilyDeletion] Dependencies changed; review the workspace again",
        { code: "FAMILY_DELETION_PREVIEW_STALE" },
      );
    const unsettled = snapshot.records.filter((record) => record.unsettled);
    if (unsettled.length)
      throw new ElizaError(
        "[FamilyDeletion] Finish or reconcile in-flight work before deleting the workspace",
        {
          code: "FAMILY_DELETION_WORK_UNSETTLED",
          context: {
            records: unsettled.map(({ kind, identity }) => ({
              kind,
              identity,
            })),
          },
        },
      );
    // Lease expiry does not cancel an external request. Keep its ownership and
    // receipts until the executor has completed or explicitly reconciled it.
    return revoke(tx, snapshot);
  });
}
