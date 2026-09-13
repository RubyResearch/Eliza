/**
 * Builds an owner-private family workspace archive from retained source bytes,
 * immutable agreement exports and one snapshot of packet/workflow records.
 * Approval receipts are exported as recorded evidence, never as inferred sends.
 */
import { createHash, randomUUID } from "node:crypto";
import { createZipArchive } from "@elizaos/agent/api/zip-utils";
import {
  DocumentService,
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  resolveOwnerEntityIdOrDefault,
  ServiceType,
  validateUuid,
} from "@elizaos/core";
import { z } from "zod";
import { getAgreementKnowledgeService } from "../household/agreement-knowledge.js";
import { executeRawSql, sqlQuote } from "../sql.js";

const recordSchema = z.record(z.string(), z.json());
type ExportRecord = z.infer<typeof recordSchema>;

// Explicit projections keep executor leases and connection credentials outside
// the portable owner record even when the underlying schemas grow.
const SOURCES = [
  {
    key: "intakeReviews",
    table: "app_lifeops.life_family_intake_reviews",
    columns: "id,period_key,document_id,revision,status,review_json",
  },
  {
    key: "packets",
    table: "app_lifeops.life_family_packets",
    columns:
      "packet_id,period_key,internal_version,content_sha256,packet_json,created_at",
  },
  {
    key: "drafts",
    table: "app_lifeops.life_family_packet_drafts",
    columns:
      "packet_id,internal_version,draft_version,recipient,recipient_entity_id,calendar_privacy_mode,included_claim_ids_json,body,body_sha256,transformations_json,email_json,created_at",
  },
  {
    key: "packetApprovals",
    table: "app_lifeops.life_family_packet_approvals",
    columns: "packet_id,draft_version,draft_sha256,approval_id,created_at",
  },
  {
    key: "workflowRuns",
    table: "app_lifeops.life_family_workflow_runs",
    columns:
      "period_key,run_id,state,trigger_kind,result_json,created_at,updated_at",
  },
  {
    key: "schoolSources",
    table: "app_lifeops.life_school_calendar_sources",
    columns:
      "source_id,config_json,last_content_sha256,last_media_url,calendar_contract_version,created_at,updated_at",
  },
  {
    key: "schoolRuns",
    table: "app_lifeops.life_school_calendar_runs",
    columns:
      "run_id,source_id,state,trigger_kind,discovered_pdf_url,content_sha256,media_url,semantic_sha256,plan_json,error_code,error_message,created_at,updated_at",
  },
  {
    key: "schoolEvents",
    table: "app_lifeops.life_school_calendar_events",
    columns:
      "source_id,event_key,semantic_json,provider_event_id,provider_version,active,updated_at",
  },
  {
    key: "schoolMutations",
    table: "app_lifeops.life_school_calendar_apply_operations",
    columns:
      "run_id,operation_index,event_key,kind,change_json,state,receipt_json,error_code,error_message,created_at,updated_at",
  },
] as const;

function failure(
  message: string,
  code: string,
  context?: Record<string, string>,
): never {
  throw new ElizaError(`[FamilyWorkspaceExport] ${message}`, { code, context });
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRecords(runtime: IAgentRuntime) {
  const available = await executeRawSql(
    runtime,
    SOURCES.map(
      (source) =>
        `SELECT ${sqlQuote(source.key)} AS kind, to_regclass(${sqlQuote(source.table)}) IS NOT NULL AS available`,
    ).join(" UNION ALL "),
  );
  const missing = SOURCES.filter(
    (source) =>
      !available.some(
        (row) => row.kind === source.key && row.available === true,
      ),
  );
  const present = SOURCES.filter((source) => !missing.includes(source));
  const scoped = `agent_id = ${sqlQuote(runtime.agentId)}`;
  const queries = present.map(
    (source) =>
      `SELECT ${sqlQuote(source.key)} AS kind, to_jsonb(record)::text AS payload FROM (SELECT ${source.columns} FROM ${source.table} WHERE ${scoped}) AS record`,
  );
  if (present.some((source) => source.key === "packetApprovals")) {
    queries.push(`SELECT 'approvals' AS kind, to_jsonb(record)::text AS payload FROM (
      SELECT id,state,requested_by,subject_user_id,action,payload,channel,reason,expires_at,resolved_at,resolved_by,resolution_reason,execution_provider,dispatch_started_at,provider_receipt,execution_error,reconciliation_resolved_at,reconciliation_reason,created_at,updated_at
      FROM approval_requests WHERE ${scoped} AND id::text IN (
        SELECT approval_id FROM app_lifeops.life_family_packet_approvals WHERE ${scoped}
      )) AS record`);
  }
  const records: Record<string, ExportRecord[]> = {};
  for (const source of present) records[source.key] = [];
  if (present.some((source) => source.key === "packetApprovals"))
    records.approvals = [];
  if (queries.length) {
    for (const row of await executeRawSql(
      runtime,
      queries.join(" UNION ALL "),
    )) {
      const key = z.string().parse(row.kind);
      const destination = records[key];
      if (!destination)
        failure(
          "Unexpected workspace record category",
          "FAMILY_EXPORT_INVALID_RECORD",
        );
      try {
        destination.push(
          recordSchema.parse(JSON.parse(z.string().parse(row.payload))),
        );
      } catch (cause) {
        // error-policy:J2 Corrupt persisted records cannot become a partial archive.
        throw new ElizaError(
          "[FamilyWorkspaceExport] A persisted workspace record is invalid",
          {
            code: "FAMILY_EXPORT_INVALID_RECORD",
            cause,
            context: { category: key },
          },
        );
      }
    }
  }
  for (const rows of Object.values(records))
    rows.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return {
    records,
    unavailable: missing.map((source) => ({
      category: source.key,
      reason:
        "This component has no initialized record store; historical activity is unavailable.",
    })),
  };
}

export async function exportFamilyWorkspace(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
  const agreements = getAgreementKnowledgeService(runtime);
  if (!agreements)
    failure(
      "Agreement knowledge service is unavailable",
      "FAMILY_EXPORT_UNAVAILABLE",
    );
  // The domain service validates the owner before any workspace records or
  // private source bytes are read. Caller-supplied household IDs cannot widen it.
  const captureStartedAt = new Date().toISOString();
  const sources = await agreements.listOwnerAgreements({ ownerEntityId });
  const snapshot = await readRecords(runtime);
  const files: Array<{ name: string; data: Buffer | string }> = [];
  const sourceArchives = [];
  for (const source of sources) {
    const archive = await agreements.exportOwnerAgreement({
      artifactId: source.artifact.id,
      ownerEntityId,
    });
    const name = `agreements/${sha256(source.artifact.id)}.zip`;
    files.push({ name, data: archive.bytes });
    sourceArchives.push({
      artifactId: source.artifact.id,
      householdId: source.artifact.householdId,
      agreementKey: source.artifact.agreementKey,
      version: source.artifact.version,
      contentSha256: source.artifact.contentSha256,
      path: name,
      archiveSha256: sha256(archive.bytes),
    });
  }
  const schoolFiles = [];
  const retained = new Set<string>();
  const schoolRuns = snapshot.records.schoolRuns;
  if (schoolRuns !== undefined)
    for (const row of schoolRuns) {
      if (row.content_sha256 === null) continue;
      const digest = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(row.content_sha256);
      if (retained.has(digest)) continue;
      const url = z
        .string()
        .regex(/^\/api\/media\/[a-f0-9]{64}\.pdf$/)
        .parse(row.media_url);
      const fileName = url.replace("/api/media/", "");
      if (fileName !== `${digest}.pdf`)
        failure(
          "Retained school source reference does not match its recorded hash",
          "FAMILY_EXPORT_SOURCE_INTEGRITY",
        );
      const storage = runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      if (!storage)
        failure(
          "Canonical file storage service is unavailable",
          "FAMILY_EXPORT_UNAVAILABLE",
        );
      const bytes = await storage.read(fileName);
      if (!bytes || sha256(bytes) !== digest)
        failure(
          "Retained school PDF is missing or failed integrity verification",
          "FAMILY_EXPORT_SOURCE_INTEGRITY",
        );
      const name = `school/${digest}.pdf`;
      files.push({ name, data: bytes });
      schoolFiles.push({ path: name, sha256: digest, byteSize: bytes.length });
      retained.add(digest);
    }
  const intakeSources = [];
  const intakeReferences = new Set<string>();
  const intakeReferenceSchema = z.object({
    document_id: z.string(),
    review_json: z.object({
      source: z.object({
        documentId: z.string(),
        contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    }),
  });
  const intakeReviews = snapshot.records.intakeReviews;
  if (intakeReviews !== undefined)
    for (const row of intakeReviews) {
      const parsed = intakeReferenceSchema.safeParse(row);
      if (!parsed.success)
        failure(
          "A selected source reference is invalid",
          "FAMILY_EXPORT_INVALID_RECORD",
        );
      const source = parsed.data.review_json.source;
      const documentId = validateUuid(source.documentId);
      if (!documentId || source.documentId !== parsed.data.document_id)
        failure(
          "A selected source identity is inconsistent",
          "FAMILY_EXPORT_INVALID_RECORD",
        );
      const name = `correspondence/${documentId}/${source.contentSha256}.txt`;
      if (intakeReferences.has(name)) continue;
      const documents = runtime.getService<DocumentService>(
        DocumentService.serviceType,
      );
      if (!documents)
        failure(
          "Canonical document service is unavailable",
          "FAMILY_EXPORT_UNAVAILABLE",
        );
      const document = await documents.getDocumentByIdWithAccessContext(
        documentId,
        {
          requesterEntityId: resolveOwnerEntityIdOrDefault(runtime),
          role: "OWNER",
          isOwner: true,
        },
      );
      if (!document || document.id !== documentId)
        failure(
          "Retained selected correspondence is unavailable to this owner",
          "FAMILY_EXPORT_SOURCE_UNAVAILABLE",
          { documentId, expectedSha256: source.contentSha256 },
        );
      const metadata = z
        .object({
          ingestionState: z.literal("ready"),
          contentType: z.literal("text/plain"),
        })
        .safeParse(document.metadata);
      const text = document.content.text;
      if (
        !metadata.success ||
        typeof text !== "string" ||
        sha256(text) !== source.contentSha256
      )
        failure(
          "Retained selected correspondence changed or failed integrity verification",
          "FAMILY_EXPORT_SOURCE_INTEGRITY",
          { documentId, expectedSha256: source.contentSha256 },
        );
      const bytes = Buffer.from(text, "utf8");
      files.push({ name, data: bytes });
      intakeSources.push({
        documentId,
        contentSha256: source.contentSha256,
        path: name,
        byteSize: bytes.length,
      });
      intakeReferences.add(name);
    }
  const exportId = `family_export_${randomUUID()}`;
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        schema: "elizaos.family-workspace-export",
        schemaVersion: 1,
        exportId,
        agentId: runtime.agentId,
        captureStartedAt,
        captureCompletedAt: new Date().toISOString(),
        scope:
          "All family agreement versions, selected correspondence and intake review revisions, school workflow records and monthly packets owned by this agent. Unrelated documents, calendars, inboxes and connection credentials are excluded.",
        consistency:
          "Intake, packet and workflow records share one database statement snapshot. Selected correspondence is read through owner document access and must match every retained review hash. Each nested agreement archive records its own review/access snapshot and source-byte checksums.",
        sourceArchives,
        schoolFiles,
        intakeSources,
        ...snapshot,
        receiptCoverage:
          "Only stored approval states, provider receipts and school mutation receipts are included. Missing receipts do not establish delivery. This preparation does not assert successful client download.",
      },
      null,
      2,
    )}\n`,
  );
  files.push({ name: "manifest.json", data: manifest });
  const sums = files
    .map((file) => `${sha256(file.data)}  ${file.name}\n`)
    .join("");
  const bytes = createZipArchive([
    ...files,
    { name: "SHA256SUMS", data: sums },
  ]);
  const at = new Date().toISOString();
  await executeRawSql(
    runtime,
    `INSERT INTO app_lifeops.life_audit_events (id,agent_id,event_type,owner_type,owner_id,reason,inputs_json,decision_json,actor,created_at) VALUES (
    ${sqlQuote(exportId)},${sqlQuote(runtime.agentId)},'family_workspace_export_prepared','family_workspace',${sqlQuote(runtime.agentId)},
    'Verified workspace archive prepared for owner download; client receipt is not asserted',
    ${sqlQuote(JSON.stringify({ ownerEntityId, sourceArtifactIds: sourceArchives.map((source) => source.artifactId) }))},
    ${sqlQuote(JSON.stringify({ manifestSha256: sha256(manifest), archiveSha256: sha256(bytes) }))},'owner',${sqlQuote(at)})`,
  );
  return {
    bytes,
    mimeType: "application/zip",
    fileName: `family-workspace-${exportId}.zip`,
  };
}
