/**
 * Immutable parenting-agreement knowledge with reviewed citations and
 * resource-scoped guest access. Agreement bytes remain in the runtime's
 * content-addressed file service; this module stores only durable metadata,
 * review decisions, pins, and authorization bindings.
 */

import crypto from "node:crypto";
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { createZipArchive } from "@elizaos/agent/api/zip-utils";
import {
  ChannelType,
  DocumentService,
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  Service,
  ServiceType,
  type UUID,
  withStandaloneTrajectory,
} from "@elizaos/core";
import type { PdfCompleteDocument, PdfService } from "@elizaos/plugin-pdf";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { z } from "zod";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlQuote,
  sqlText,
  toNumber,
  toText,
  withTransaction,
} from "../sql.js";
import { agreementMutationSql } from "./agreement-audit.js";
import {
  type AgreementReviewProposal,
  type AgreementReviewSource,
  type GeneratedAgreementReview,
  generateAgreementReview,
  validateAgreementReviewProposal,
} from "./agreement-review.js";
import {
  getHouseholdCoordinationService,
  HOUSEHOLD_COORDINATION_SERVICE,
  type HouseholdCoordinationService,
} from "./service.js";
import {
  DEFAULT_HOUSEHOLD_ID,
  HouseholdCoordinationError,
  type HouseholdRole,
  normalizeHouseholdIdentifier,
} from "./types.js";

const agreementExtractionSchema = z.strictObject({
  complete: z.literal(true),
  pageCount: z.number().int().positive(),
  text: z.string(),
  pages: z.array(
    z.strictObject({
      pageNumber: z.number().int().positive(),
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
      method: z.enum(["native", "native+vision", "vision", "blank"]),
      nativeText: z.string(),
      nativePositionedText: z.array(
        z.strictObject({
          page: z.number().int().positive(),
          text: z.string(),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      ),
      ocrText: z.string().nullable(),
      visionText: z.string().nullable(),
      text: z.string(),
      hasVisualContent: z.boolean(),
    }),
  ),
});

import {
  assertFamilyWorkspaceReadable,
  beginFamilyWorkspaceOperation,
  settleFamilyWorkspaceOperation,
  withActiveFamilyWorkspaceTransaction,
} from "../family-workflows/workspace-operation-store.js";

export const HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE =
  "lifeops_household_agreement_knowledge";

interface AgreementOcrService {
  describe(input: {
    displayId: string;
    sourceX: number;
    sourceY: number;
    pngBytes: Uint8Array;
  }): Promise<{ blocks: ReadonlyArray<{ text: string }> }>;
}

async function resolveAgreementOcr(): Promise<AgreementOcrService | null> {
  const specifier: string = "@elizaos/plugin-vision/ocr-with-coords";
  try {
    const module = (await import(specifier)) as {
      getOcrWithCoordsService?: () => AgreementOcrService | null;
    };
    return module.getOcrWithCoordsService?.() ?? null;
  } catch {
    // error-policy:J4 OCR is an optional enrichment; strict rendered-page
    // IMAGE_DESCRIPTION transcription remains required and visible.
    return null;
  }
}

export type AgreementObligationStatus = "proposed" | "approved" | "rejected";
export type KnowledgePinTargetType = "agent" | "chat";

/** Current destinations an owner can select without entering technical identifiers. */
export interface AgreementPinTargets {
  agent: { id: string; name: string | null };
  chats: Array<{ id: string; name: string | null; source: string }>;
}

/** Owner-visible choices retain exact permission identities behind human-readable labels. */
export interface AgreementGuestAccessOptions {
  candidates: Array<{
    principalEntityId: string;
    householdGrantId: string;
    displayName: string | null;
    identityLabel: string;
    role: HouseholdRole;
    expiresAt: string | null;
    issuedAt: string;
  }>;
  grants: Array<{
    grantId: string;
    principalEntityId: string;
    householdGrantId: string;
    displayName: string | null;
    issuedAt: string;
    canRead: boolean;
    denial: string | null;
  }>;
}

export interface ParentingAgreementArtifact {
  id: string;
  agentId: string;
  householdId: string;
  agreementKey: string;
  version: number;
  supersedesArtifactId: string | null;
  title: string;
  originalFilename: string;
  documentId: string;
  mediaUrl: string;
  mediaFileName: string;
  contentSha256: string;
  mimeType: string;
  byteSize: number;
  pageCount: number;
  uploadedByEntityId: string;
  createdAt: string;
}

export interface ParentingAgreementObligation {
  id: string;
  agentId: string;
  artifactId: string;
  title: string;
  obligationText: string;
  pageStart: number;
  pageEnd: number;
  citationText: string;
  status: AgreementObligationStatus;
  proposedByEntityId: string;
  decidedByEntityId: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const preparedReviewSchema = z.strictObject({
  artifactId: z.string(),
  sourceSha256: z.string(),
  extractionSha256: z.string(),
  generatedAt: z.string(),
  explanation: z.string().min(1),
  obligationIds: z.array(z.string()),
});

type PreparedReviewRecord = z.infer<typeof preparedReviewSchema>;

function preparedReviewFromJson(value: unknown): PreparedReviewRecord {
  try {
    return preparedReviewSchema.parse(
      JSON.parse(requiredText(value, "decision_json")),
    );
  } catch (cause) {
    // error-policy:J2 A corrupt durable review is unavailable, not a reason to regenerate it.
    throw new AgreementKnowledgeError(
      "Prepared agreement review is invalid",
      "AGREEMENT_INVALID_CONTRACT",
      undefined,
      cause,
    );
  }
}

export interface PreparedAgreementReview {
  artifactId: string;
  generatedAt: string;
  explanation: string;
  outcome: "proposals" | "no_proposals";
  obligations: ParentingAgreementObligation[];
}

export interface HouseholdKnowledgePin {
  id: string;
  agentId: string;
  artifactId: string;
  targetType: KnowledgePinTargetType;
  targetId: string;
  pinnedByEntityId: string;
  pinnedAt: string;
  unpinnedAt: string | null;
}

export interface HouseholdKnowledgeGrant {
  id: string;
  agentId: string;
  householdId: string;
  artifactId: string;
  principalEntityId: string;
  householdGrantId: string;
  issuedByEntityId: string;
  revokedAt: string | null;
  revokedByEntityId: string | null;
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParentingAgreementView {
  artifact: ParentingAgreementArtifact;
  obligations: ParentingAgreementObligation[];
}

/** Guest-safe source metadata. Permanent byte capabilities and owner internals are excluded. */
export type ParentingAgreementGuestArtifact = Pick<
  ParentingAgreementArtifact,
  | "id"
  | "version"
  | "title"
  | "originalFilename"
  | "mimeType"
  | "byteSize"
  | "pageCount"
  | "createdAt"
>;

export interface ParentingAgreementGuestView {
  artifact: ParentingAgreementGuestArtifact;
  obligations: ParentingAgreementGuestObligation[];
}

export type ParentingAgreementGuestObligation = Pick<
  ParentingAgreementObligation,
  | "id"
  | "title"
  | "obligationText"
  | "pageStart"
  | "pageEnd"
  | "citationText"
  | "status"
  | "decidedAt"
>;

export interface AgreementGuestGrantPreview {
  allowed: boolean;
  artifactId: string;
  principalEntityId: string;
  householdGrantId: string;
  effects: readonly ["read_artifact_metadata", "read_approved_obligations"];
  exclusions: readonly [
    "read_proposed_or_rejected_obligations",
    "mutate_agreement",
    "inherit_access_from_pin",
  ];
  denial: { code: string; message: string } | null;
}

type AgreementKnowledgeErrorCode =
  | "AGREEMENT_ACCESS_DENIED"
  | "AGREEMENT_ARTIFACT_NOT_FOUND"
  | "AGREEMENT_DUPLICATE_CONTENT"
  | "AGREEMENT_INVALID_CONTRACT"
  | "AGREEMENT_OBLIGATION_CONFLICT"
  | "AGREEMENT_STORAGE_UNAVAILABLE"
  | "AGREEMENT_EXTRACTION_UNAVAILABLE"
  | "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED"
  | "AGREEMENT_INGESTION_CLEANUP_FAILED";

export class AgreementKnowledgeError extends ElizaError {
  override readonly name = "AgreementKnowledgeError";

  constructor(
    message: string,
    code: AgreementKnowledgeErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity: code === "AGREEMENT_INVALID_CONTRACT" ? "fatal" : "ephemeral",
    });
  }
}

/** An ingestion failure whose operation settled before any source persistence began. */
export class AgreementSourceUnchangedError extends AgreementKnowledgeError {}

function requiredText(value: unknown, field: string): string {
  const text = toText(value).trim();
  if (!text) {
    throw new AgreementKnowledgeError(
      `Persisted agreement row is missing ${field}`,
      "AGREEMENT_INVALID_CONTRACT",
      { field },
    );
  }
  return text;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return toText(value);
}

function positiveInteger(value: unknown, field: string): number {
  const number = toNumber(value, Number.NaN);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AgreementKnowledgeError(
      `Persisted agreement row has invalid ${field}`,
      "AGREEMENT_INVALID_CONTRACT",
      { field, value: toText(value) },
    );
  }
  return number;
}

function obligationStatus(value: unknown): AgreementObligationStatus {
  if (value === "proposed" || value === "approved" || value === "rejected") {
    return value;
  }
  throw new AgreementKnowledgeError(
    "Persisted agreement obligation has an invalid status",
    "AGREEMENT_INVALID_CONTRACT",
    { status: toText(value) },
  );
}

function artifactFromRow(
  row: Record<string, unknown>,
): ParentingAgreementArtifact {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    agreementKey: requiredText(row.agreement_key, "agreementKey"),
    version: positiveInteger(row.version, "version"),
    supersedesArtifactId: optionalText(row.supersedes_artifact_id),
    title: requiredText(row.title, "title"),
    originalFilename: requiredText(row.original_filename, "originalFilename"),
    documentId: requiredText(row.document_id, "documentId"),
    mediaUrl: requiredText(row.media_url, "mediaUrl"),
    mediaFileName: requiredText(row.media_file_name, "mediaFileName"),
    contentSha256: requiredText(row.content_sha256, "contentSha256"),
    mimeType: requiredText(row.mime_type, "mimeType"),
    byteSize: positiveInteger(row.byte_size, "byteSize"),
    pageCount: positiveInteger(row.page_count, "pageCount"),
    uploadedByEntityId: requiredText(
      row.uploaded_by_entity_id,
      "uploadedByEntityId",
    ),
    createdAt: requiredText(row.created_at, "createdAt"),
  };
}

function obligationFromRow(
  row: Record<string, unknown>,
): ParentingAgreementObligation {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    artifactId: requiredText(row.artifact_id, "artifactId"),
    title: requiredText(row.title, "title"),
    obligationText: requiredText(row.obligation_text, "obligationText"),
    pageStart: positiveInteger(row.page_start, "pageStart"),
    pageEnd: positiveInteger(row.page_end, "pageEnd"),
    citationText: requiredText(row.citation_text, "citationText"),
    status: obligationStatus(row.status),
    proposedByEntityId: requiredText(
      row.proposed_by_entity_id,
      "proposedByEntityId",
    ),
    decidedByEntityId: optionalText(row.decided_by_entity_id),
    decisionReason: optionalText(row.decision_reason),
    decidedAt: optionalText(row.decided_at),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function pinFromRow(row: Record<string, unknown>): HouseholdKnowledgePin {
  const targetType = requiredText(row.target_type, "targetType");
  if (targetType !== "agent" && targetType !== "chat") {
    throw new AgreementKnowledgeError(
      "Persisted knowledge pin has an invalid target type",
      "AGREEMENT_INVALID_CONTRACT",
      { targetType },
    );
  }
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    artifactId: requiredText(row.artifact_id, "artifactId"),
    targetType,
    targetId: requiredText(row.target_id, "targetId"),
    pinnedByEntityId: requiredText(row.pinned_by_entity_id, "pinnedByEntityId"),
    pinnedAt: requiredText(row.pinned_at, "pinnedAt"),
    unpinnedAt: optionalText(row.unpinned_at),
  };
}

function grantFromRow(row: Record<string, unknown>): HouseholdKnowledgeGrant {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    householdId: requiredText(row.household_id, "householdId"),
    artifactId: requiredText(row.artifact_id, "artifactId"),
    principalEntityId: requiredText(
      row.principal_entity_id,
      "principalEntityId",
    ),
    householdGrantId: requiredText(row.household_grant_id, "householdGrantId"),
    issuedByEntityId: requiredText(row.issued_by_entity_id, "issuedByEntityId"),
    revokedAt: optionalText(row.revoked_at),
    revokedByEntityId: optionalText(row.revoked_by_entity_id),
    revocationReason: optionalText(row.revocation_reason),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

export class AgreementKnowledgeRepository {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  private async executeAgreementMutation(statement: string) {
    return withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_audit_events",
        "app_lifeops.life_household_agreement_artifacts",
        "app_lifeops.life_household_agreement_obligations",
        "app_lifeops.life_household_knowledge_pins",
        "app_lifeops.life_household_knowledge_grants",
      ],
      (tx) => executeRawSqlTx(tx, statement),
    );
  }

  /** All mutable export records are read from one PostgreSQL statement snapshot. */
  async readExportSnapshot(artifactId: string) {
    const scoped = `agent_id = ${sqlQuote(this.agentId)}`;
    const artifact = sqlQuote(artifactId);
    const linkedHouseholdGrants = `SELECT household_grant_id FROM app_lifeops.life_household_knowledge_grants
      WHERE ${scoped} AND artifact_id = ${artifact}
      UNION SELECT decision_json::jsonb->>'household_grant_id' FROM app_lifeops.life_audit_events
      WHERE ${scoped} AND owner_type = 'parenting_agreement' AND owner_id = ${artifact}
        AND event_type IN ('agreement_granted', 'agreement_revoked')`;
    const queries = [
      ["artifact", "life_household_agreement_artifacts", `id = ${artifact}`],
      [
        "obligation",
        "life_household_agreement_obligations",
        `artifact_id = ${artifact}`,
      ],
      ["pin", "life_household_knowledge_pins", `artifact_id = ${artifact}`],
      ["grant", "life_household_knowledge_grants", `artifact_id = ${artifact}`],
      [
        "householdGrant",
        "life_household_access_grants",
        `id IN (${linkedHouseholdGrants})`,
      ],
      [
        "householdAudit",
        "life_audit_events",
        `owner_type = 'household_grant' AND owner_id IN (${linkedHouseholdGrants})`,
      ],
      [
        "audit",
        "life_audit_events",
        `owner_type = 'parenting_agreement' AND owner_id = ${artifact}`,
      ],
    ];
    const rows = await executeRawSql(
      this.runtime,
      queries
        .map(
          ([kind, table, condition]) =>
            `SELECT ${sqlQuote(kind)} AS kind, to_jsonb(record)::text AS payload
       FROM app_lifeops.${table} AS record WHERE ${scoped} AND ${condition}`,
        )
        .join(" UNION ALL "),
    );
    const records = rows.map((row) => {
      try {
        return {
          kind: requiredText(row.kind, "kind"),
          row: z
            .record(z.string(), z.json())
            .parse(JSON.parse(requiredText(row.payload, "payload"))),
        };
      } catch (error) {
        // error-policy:J2 A corrupt snapshot cannot become a partial export.
        throw new AgreementKnowledgeError(
          "Agreement export snapshot is invalid",
          "AGREEMENT_INVALID_CONTRACT",
          { artifactId },
          error,
        );
      }
    });
    const source = records.find((record) => record.kind === "artifact");
    if (!source)
      throw new AgreementKnowledgeError(
        "Parenting-agreement artifact was not found",
        "AGREEMENT_ARTIFACT_NOT_FOUND",
        { artifactId },
      );
    const ofKind = (kind: string) =>
      records
        .filter((record) => record.kind === kind)
        .map((record) => record.row)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return {
      artifact: artifactFromRow(source.row),
      obligations: ofKind("obligation").map(obligationFromRow),
      pins: ofKind("pin").map(pinFromRow),
      grants: ofKind("grant").map(grantFromRow),
      householdGrants: ofKind("householdGrant"),
      householdGrantAudit: ofKind("householdAudit"),
      audit: ofKind("audit").sort(
        (left, right) =>
          String(left.created_at).localeCompare(String(right.created_at)) ||
          String(left.id).localeCompare(String(right.id)),
      ),
    };
  }

  async recordExport(input: {
    artifact: ParentingAgreementArtifact;
    exportId: string;
    ownerEntityId: string;
    createdAt: string;
    manifestSha256: string;
    archiveSha256: string;
  }) {
    const rows = await withActiveFamilyWorkspaceTransaction(
      this.runtime,
      ["app_lifeops.life_audit_events"],
      (tx) =>
        executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_audit_events (
      id, agent_id, event_type, owner_type, owner_id, reason, inputs_json, decision_json, actor, created_at
    ) VALUES (${sqlQuote(input.exportId)}, ${sqlQuote(this.agentId)}, 'agreement_export_prepared', 'parenting_agreement', ${sqlQuote(input.artifact.id)},
      'Verified archive prepared for owner download; client receipt is not asserted',
      ${sqlQuote(JSON.stringify({ schemaVersion: 1, actorEntityId: input.ownerEntityId, source: { id: input.artifact.id, version: input.artifact.version, content_sha256: input.artifact.contentSha256 } }))},
      ${sqlQuote(JSON.stringify({ manifestSha256: input.manifestSha256, archiveSha256: input.archiveSha256 }))}, 'owner', ${sqlQuote(input.createdAt)}) RETURNING id`,
        ),
      this.agentId,
    );
    if (rows.length !== 1)
      throw new AgreementKnowledgeError(
        "Agreement export audit was not persisted",
        "AGREEMENT_INVALID_CONTRACT",
      );
  }

  async insertArtifact(
    input: Omit<ParentingAgreementArtifact, "version"> & {
      extractionSha256: string;
    },
  ) {
    return await withTransaction(this.runtime, async (tx) => {
      const previousRows = await executeRawSqlTx(
        tx,
        `SELECT * FROM app_lifeops.life_household_agreement_artifacts
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND household_id = ${sqlQuote(input.householdId)}
            AND agreement_key = ${sqlQuote(input.agreementKey)}
          ORDER BY version DESC
          LIMIT 1
          FOR UPDATE`,
      );
      const previous = previousRows[0]
        ? artifactFromRow(previousRows[0])
        : null;
      if (previous?.contentSha256 === input.contentSha256) {
        throw new AgreementKnowledgeError(
          "This agreement content is already the current immutable version",
          "AGREEMENT_DUPLICATE_CONTENT",
          { artifactId: previous.id, contentSha256: input.contentSha256 },
        );
      }
      const version = (previous?.version ?? 0) + 1;
      const rows = await executeRawSqlTx(
        tx,
        agreementMutationSql(
          `INSERT INTO app_lifeops.life_household_agreement_artifacts (
           id, agent_id, household_id, agreement_key, version,
           supersedes_artifact_id, title, original_filename, document_id, media_url,
           media_file_name, content_sha256, mime_type, byte_size, page_count,
           uploaded_by_entity_id, created_at
         ) VALUES (
           ${sqlQuote(input.id)}, ${sqlQuote(this.agentId)},
           ${sqlQuote(input.householdId)}, ${sqlQuote(input.agreementKey)},
           ${sqlInteger(version)}, ${sqlText(previous?.id ?? null)},
           ${sqlQuote(input.title)}, ${sqlQuote(input.originalFilename)},
           ${sqlQuote(input.documentId)},
           ${sqlQuote(input.mediaUrl)}, ${sqlQuote(input.mediaFileName)},
           ${sqlQuote(input.contentSha256)}, ${sqlQuote(input.mimeType)},
           ${sqlInteger(input.byteSize)}, ${sqlInteger(input.pageCount)},
           ${sqlQuote(input.uploadedByEntityId)}, ${sqlQuote(input.createdAt)}
         ) RETURNING *`,
          {
            agentId: this.agentId,
            kind: "agreement_ingested",
            actorEntityId: input.uploadedByEntityId,
            createdAt: input.createdAt,
            artifactRow: true,
            extractionSha256: input.extractionSha256,
          },
        ),
      );
      const row = rows[0];
      if (!row) {
        throw new AgreementKnowledgeError(
          "Agreement version insert returned no persisted row",
          "AGREEMENT_INVALID_CONTRACT",
        );
      }
      return artifactFromRow(row);
    });
  }

  async getArtifact(id: string): Promise<ParentingAgreementArtifact | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)} AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    return rows[0] ? artifactFromRow(rows[0]) : null;
  }

  async listArtifacts(
    householdId?: string,
  ): Promise<ParentingAgreementArtifact[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)}
          ${householdId ? `AND household_id = ${sqlQuote(householdId)}` : ""}
        ORDER BY agreement_key ASC, version DESC, created_at DESC, id ASC`,
    );
    return rows.map(artifactFromRow);
  }

  async getArtifactByContent(input: {
    householdId: string;
    agreementKey: string;
    contentSha256: string;
  }): Promise<ParentingAgreementArtifact | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND household_id = ${sqlQuote(input.householdId)}
          AND agreement_key = ${sqlQuote(input.agreementKey)}
          AND content_sha256 = ${sqlQuote(input.contentSha256)}
        LIMIT 1`,
    );
    return rows[0] ? artifactFromRow(rows[0]) : null;
  }

  private obligationInsertSql(
    obligation: ParentingAgreementObligation,
  ): string {
    return agreementMutationSql(
      `INSERT INTO app_lifeops.life_household_agreement_obligations (
         id, agent_id, artifact_id, title, obligation_text, page_start,
         page_end, citation_text, status, proposed_by_entity_id,
         decided_by_entity_id, decision_reason, decided_at, created_at, updated_at
       ) VALUES (
         ${sqlQuote(obligation.id)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(obligation.artifactId)}, ${sqlQuote(obligation.title)},
         ${sqlQuote(obligation.obligationText)},
         ${sqlInteger(obligation.pageStart)}, ${sqlInteger(obligation.pageEnd)},
         ${sqlQuote(obligation.citationText)}, 'proposed',
         ${sqlQuote(obligation.proposedByEntityId)}, NULL, NULL, NULL,
         ${sqlQuote(obligation.createdAt)}, ${sqlQuote(obligation.updatedAt)}
       ) RETURNING *`,
      {
        agentId: this.agentId,
        kind: "agreement_obligation_proposed",
        actorEntityId: obligation.proposedByEntityId,
        createdAt: obligation.createdAt,
      },
    );
  }

  async insertObligation(
    obligation: ParentingAgreementObligation,
  ): Promise<ParentingAgreementObligation> {
    const rows = await this.executeAgreementMutation(
      this.obligationInsertSql(obligation),
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Agreement obligation insert returned no persisted row",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return obligationFromRow(row);
  }

  /** Serializes correction retries with other review writes without resetting a saved decision. */
  async insertOwnerProposalOnce(
    obligation: ParentingAgreementObligation,
  ): Promise<{ obligation: ParentingAgreementObligation; created: boolean }> {
    return withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_audit_events",
        "app_lifeops.life_household_agreement_artifacts",
        "app_lifeops.life_household_agreement_obligations",
        "app_lifeops.life_household_knowledge_pins",
        "app_lifeops.life_household_knowledge_grants",
      ],
      async (tx) => {
        const artifacts = await executeRawSqlTx(
          tx,
          `SELECT id FROM app_lifeops.life_household_agreement_artifacts
         WHERE agent_id = ${sqlQuote(this.agentId)} AND id = ${sqlQuote(obligation.artifactId)} FOR UPDATE`,
        );
        if (artifacts.length !== 1)
          throw new AgreementKnowledgeError(
            "Agreement source is unavailable",
            "AGREEMENT_ARTIFACT_NOT_FOUND",
          );
        const existing = await executeRawSqlTx(
          tx,
          `SELECT * FROM app_lifeops.life_household_agreement_obligations
         WHERE agent_id = ${sqlQuote(this.agentId)} AND artifact_id = ${sqlQuote(obligation.artifactId)} AND id = ${sqlQuote(obligation.id)}`,
        );
        if (existing[0])
          return { obligation: obligationFromRow(existing[0]), created: false };
        const inserted = await executeRawSqlTx(
          tx,
          this.obligationInsertSql(obligation),
        );
        if (inserted.length !== 1 || !inserted[0])
          throw new AgreementKnowledgeError(
            "Owner proposal did not persist",
            "AGREEMENT_STORAGE_UNAVAILABLE",
          );
        return { obligation: obligationFromRow(inserted[0]), created: true };
      },
    );
  }

  async readPreparedReview(
    artifactId: string,
  ): Promise<PreparedReviewRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT decision_json FROM app_lifeops.life_audit_events
      WHERE agent_id = ${sqlQuote(this.agentId)} AND owner_type = 'parenting_agreement'
        AND owner_id = ${sqlQuote(artifactId)} AND event_type = 'agreement_review_prepared'`,
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1)
      throw new AgreementKnowledgeError(
        "Agreement has conflicting prepared review records",
        "AGREEMENT_INVALID_CONTRACT",
      );
    return preparedReviewFromJson(rows[0]?.decision_json);
  }

  async commitPreparedReview(
    record: PreparedReviewRecord,
    obligations: ParentingAgreementObligation[],
  ): Promise<PreparedReviewRecord> {
    if (
      record.obligationIds.length !== obligations.length ||
      obligations.some(
        (item, index) =>
          item.id !== record.obligationIds[index] ||
          item.artifactId !== record.artifactId ||
          item.agentId !== this.agentId ||
          item.status !== "proposed",
      )
    ) {
      throw new AgreementKnowledgeError(
        "Prepared review batch does not match its source or proposal identities",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_audit_events",
        "app_lifeops.life_household_agreement_artifacts",
        "app_lifeops.life_household_agreement_obligations",
        "app_lifeops.life_household_knowledge_pins",
        "app_lifeops.life_household_knowledge_grants",
      ],
      async (tx) => {
        const artifacts = await executeRawSqlTx(
          tx,
          `SELECT id FROM app_lifeops.life_household_agreement_artifacts
        WHERE agent_id = ${sqlQuote(this.agentId)} AND id = ${sqlQuote(record.artifactId)} FOR UPDATE`,
        );
        if (artifacts.length !== 1)
          throw new AgreementKnowledgeError(
            "Agreement source is unavailable",
            "AGREEMENT_ARTIFACT_NOT_FOUND",
          );
        const existing = await executeRawSqlTx(
          tx,
          `SELECT decision_json FROM app_lifeops.life_audit_events
        WHERE agent_id = ${sqlQuote(this.agentId)} AND owner_type = 'parenting_agreement'
          AND owner_id = ${sqlQuote(record.artifactId)} AND event_type = 'agreement_review_prepared'`,
        );
        if (existing.length === 1)
          return preparedReviewFromJson(existing[0]?.decision_json);
        if (existing.length > 1)
          throw new AgreementKnowledgeError(
            "Agreement has conflicting prepared review records",
            "AGREEMENT_INVALID_CONTRACT",
          );
        for (const obligation of obligations) {
          const inserted = await executeRawSqlTx(
            tx,
            this.obligationInsertSql(obligation),
          );
          if (inserted.length !== 1)
            throw new AgreementKnowledgeError(
              "Review proposal did not persist",
              "AGREEMENT_STORAGE_UNAVAILABLE",
            );
        }
        const saved = await executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_audit_events
        (id, agent_id, event_type, owner_type, owner_id, reason, inputs_json, decision_json, actor, created_at)
        VALUES (${sqlQuote(`agreement_review_${crypto.randomUUID()}`)}, ${sqlQuote(this.agentId)}, 'agreement_review_prepared',
          'parenting_agreement', ${sqlQuote(record.artifactId)}, 'Unapproved cited proposals prepared for owner review',
          ${sqlQuote(JSON.stringify({ sourceSha256: record.sourceSha256, extractionSha256: record.extractionSha256 }))},
          ${sqlQuote(JSON.stringify(record))}, 'owner', ${sqlQuote(record.generatedAt)}) RETURNING id`,
        );
        if (saved.length !== 1)
          throw new AgreementKnowledgeError(
            "Prepared review did not persist",
            "AGREEMENT_STORAGE_UNAVAILABLE",
          );
        return record;
      },
    );
  }

  async decideObligation(input: {
    obligationId: string;
    status: Exclude<AgreementObligationStatus, "proposed">;
    decidedByEntityId: string;
    decisionReason: string;
    decidedAt: string;
  }): Promise<ParentingAgreementObligation> {
    const rows = await this.executeAgreementMutation(
      agreementMutationSql(
        `UPDATE app_lifeops.life_household_agreement_obligations
          SET status = ${sqlQuote(input.status)},
              decided_by_entity_id = ${sqlQuote(input.decidedByEntityId)},
              decision_reason = ${sqlQuote(input.decisionReason)},
              decided_at = ${sqlQuote(input.decidedAt)},
              updated_at = ${sqlQuote(input.decidedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(input.obligationId)}
          AND status = 'proposed'
      RETURNING *`,
        {
          agentId: this.agentId,
          kind: "agreement_obligation_decided",
          actorEntityId: input.decidedByEntityId,
          createdAt: input.decidedAt,
        },
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Obligation is missing or has already received a final decision",
        "AGREEMENT_OBLIGATION_CONFLICT",
        { obligationId: input.obligationId },
      );
    }
    return obligationFromRow(row);
  }

  async listObligations(
    artifactId: string,
  ): Promise<ParentingAgreementObligation[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_obligations
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
        ORDER BY page_start ASC, page_end ASC, created_at ASC, id ASC`,
    );
    return rows.map(obligationFromRow);
  }

  async listApprovedObligations(): Promise<ParentingAgreementObligation[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_agreement_obligations
        WHERE agent_id = ${sqlQuote(this.agentId)} AND status = 'approved'
        ORDER BY updated_at ASC, id ASC`,
    );
    return rows.map(obligationFromRow);
  }

  async setPin(input: {
    artifactId: string;
    targetType: KnowledgePinTargetType;
    targetId: string;
    pinnedByEntityId: string;
    pinnedAt: string;
  }): Promise<HouseholdKnowledgePin> {
    const id = `hkpin_${crypto.randomUUID()}`;
    const rows = await this.executeAgreementMutation(
      agreementMutationSql(
        `INSERT INTO app_lifeops.life_household_knowledge_pins (
         id, agent_id, artifact_id, target_type, target_id,
         pinned_by_entity_id, pinned_at, unpinned_at
       ) VALUES (
         ${sqlQuote(id)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.artifactId)}, ${sqlQuote(input.targetType)},
         ${sqlQuote(input.targetId)}, ${sqlQuote(input.pinnedByEntityId)},
         ${sqlQuote(input.pinnedAt)}, NULL
       ) ON CONFLICT (agent_id, artifact_id, target_type, target_id)
       DO UPDATE SET pinned_by_entity_id = EXCLUDED.pinned_by_entity_id,
                     pinned_at = EXCLUDED.pinned_at,
                     unpinned_at = NULL
       RETURNING *`,
        {
          agentId: this.agentId,
          kind: "agreement_pinned",
          actorEntityId: input.pinnedByEntityId,
          createdAt: input.pinnedAt,
        },
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge pin insert returned no persisted row",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return pinFromRow(row);
  }

  async listPins(artifactId: string): Promise<HouseholdKnowledgePin[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_pins
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
          AND unpinned_at IS NULL
        ORDER BY pinned_at ASC, id ASC`,
    );
    return rows.map(pinFromRow);
  }

  async listActivePinsForTargets(
    targets: ReadonlyArray<{
      targetType: KnowledgePinTargetType;
      targetId: string;
    }>,
  ): Promise<HouseholdKnowledgePin[]> {
    if (targets.length === 0) return [];
    const targetSql = targets
      .map(
        (target) =>
          `(target_type = ${sqlQuote(target.targetType)} AND target_id = ${sqlQuote(target.targetId)})`,
      )
      .join(" OR ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_pins
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND unpinned_at IS NULL
          AND (${targetSql})
        ORDER BY pinned_at ASC, id ASC`,
    );
    return rows.map(pinFromRow);
  }

  async removePin(input: {
    pinId: string;
    unpinnedByEntityId: string;
    unpinnedAt: string;
  }): Promise<HouseholdKnowledgePin> {
    const rows = await this.executeAgreementMutation(
      agreementMutationSql(
        `UPDATE app_lifeops.life_household_knowledge_pins
          SET unpinned_at = ${sqlQuote(input.unpinnedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(input.pinId)}
          AND unpinned_at IS NULL
      RETURNING *`,
        {
          agentId: this.agentId,
          kind: "agreement_unpinned",
          actorEntityId: input.unpinnedByEntityId,
          createdAt: input.unpinnedAt,
        },
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge pin is missing or already inactive",
        "AGREEMENT_INVALID_CONTRACT",
        { pinId: input.pinId },
      );
    }
    return pinFromRow(row);
  }

  async upsertGrant(input: HouseholdKnowledgeGrant) {
    const rows = await this.executeAgreementMutation(
      agreementMutationSql(
        `INSERT INTO app_lifeops.life_household_knowledge_grants (
         id, agent_id, household_id, artifact_id, principal_entity_id,
         household_grant_id, issued_by_entity_id, revoked_at,
         revoked_by_entity_id, revocation_reason, created_at, updated_at
       ) VALUES (
         ${sqlQuote(input.id)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.householdId)}, ${sqlQuote(input.artifactId)},
         ${sqlQuote(input.principalEntityId)},
         ${sqlQuote(input.householdGrantId)},
         ${sqlQuote(input.issuedByEntityId)}, NULL, NULL, NULL,
         ${sqlQuote(input.createdAt)}, ${sqlQuote(input.updatedAt)}
       ) ON CONFLICT (agent_id, artifact_id, principal_entity_id)
       DO UPDATE SET household_grant_id = EXCLUDED.household_grant_id,
                     issued_by_entity_id = EXCLUDED.issued_by_entity_id,
                     revoked_at = NULL,
                     revoked_by_entity_id = NULL,
                     revocation_reason = NULL,
                     updated_at = EXCLUDED.updated_at
       RETURNING *`,
        {
          agentId: this.agentId,
          kind: "agreement_granted",
          actorEntityId: input.issuedByEntityId,
          createdAt: input.updatedAt,
        },
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge grant insert returned no persisted row",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    return grantFromRow(row);
  }

  async listGrants(
    artifactId: string,
    principalEntityId: string,
  ): Promise<HouseholdKnowledgeGrant[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
          AND principal_entity_id = ${sqlQuote(principalEntityId)}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(grantFromRow);
  }

  async listArtifactGrants(
    artifactId: string,
  ): Promise<HouseholdKnowledgeGrant[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_knowledge_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND artifact_id = ${sqlQuote(artifactId)}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(grantFromRow);
  }

  async revokeGrant(input: {
    grantId: string;
    revokedByEntityId: string;
    reason: string;
    revokedAt: string;
  }): Promise<HouseholdKnowledgeGrant> {
    const rows = await this.executeAgreementMutation(
      agreementMutationSql(
        `UPDATE app_lifeops.life_household_knowledge_grants
          SET revoked_at = ${sqlQuote(input.revokedAt)},
              revoked_by_entity_id = ${sqlQuote(input.revokedByEntityId)},
              revocation_reason = ${sqlQuote(input.reason)},
              updated_at = ${sqlQuote(input.revokedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(input.grantId)}
          AND revoked_at IS NULL
      RETURNING *`,
        {
          agentId: this.agentId,
          kind: "agreement_revoked",
          actorEntityId: input.revokedByEntityId,
          createdAt: input.revokedAt,
        },
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new AgreementKnowledgeError(
        "Knowledge grant is missing or already revoked",
        "AGREEMENT_ACCESS_DENIED",
        { grantId: input.grantId },
      );
    }
    return grantFromRow(row);
  }
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AgreementKnowledgeError(
      `${field} is required`,
      "AGREEMENT_INVALID_CONTRACT",
      { field },
    );
  }
  return normalized;
}

function guestArtifactProjection(
  artifact: ParentingAgreementArtifact,
): ParentingAgreementGuestArtifact {
  return {
    id: artifact.id,
    version: artifact.version,
    title: artifact.title,
    originalFilename: artifact.originalFilename,
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    pageCount: artifact.pageCount,
    createdAt: artifact.createdAt,
  };
}

function guestObligationProjection(
  obligation: ParentingAgreementObligation,
): ParentingAgreementGuestObligation {
  return {
    id: obligation.id,
    title: obligation.title,
    obligationText: obligation.obligationText,
    pageStart: obligation.pageStart,
    pageEnd: obligation.pageEnd,
    citationText: obligation.citationText,
    status: obligation.status,
    decidedAt: obligation.decidedAt,
  };
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgreementKnowledgeError(
      `${field} must be a positive integer`,
      "AGREEMENT_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value;
}

export class AgreementKnowledgeService {
  private readonly now: () => Date;
  private readonly reviewInFlight = new Map<
    string,
    Promise<PreparedAgreementReview>
  >();

  constructor(
    private readonly deps: {
      runtime: IAgentRuntime;
      agentId: string;
      entityStore: EntityStore;
      household: HouseholdCoordinationService;
      repository: AgreementKnowledgeRepository;
      fileStorage: () => IFileStorageService | null;
      documents: () => DocumentService | null;
      pdf: () => PdfService | null;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private requireOwner(actorEntityId: string): void {
    if (actorEntityId !== SELF_ENTITY_ID) {
      throw new AgreementKnowledgeError(
        "Only the owner may mutate parenting-agreement knowledge",
        "AGREEMENT_ACCESS_DENIED",
        { actorEntityId },
      );
    }
  }

  async listApprovedObligations(): Promise<ParentingAgreementObligation[]> {
    await this.requireReadableWorkspace();
    const obligations = await this.deps.repository.listApprovedObligations();
    await this.requireReadableWorkspace();
    return obligations;
  }

  private requireReadableWorkspace(): Promise<void> {
    return assertFamilyWorkspaceReadable(this.deps.runtime, this.deps.agentId);
  }

  async prepareOwnerReview(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<PreparedAgreementReview> {
    this.requireOwner(input.ownerEntityId);
    const artifactId = normalizeHouseholdIdentifier(
      input.artifactId,
      "artifactId",
    );
    const pending = this.reviewInFlight.get(artifactId);
    if (pending) return pending;
    const work = this.prepareOwnerReviewOnce(artifactId);
    this.reviewInFlight.set(artifactId, work);
    try {
      return await work;
    } finally {
      if (this.reviewInFlight.get(artifactId) === work)
        this.reviewInFlight.delete(artifactId);
    }
  }

  async readOwnerReview(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<PreparedAgreementReview | null> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const record = await this.deps.repository.readPreparedReview(artifact.id);
    if (!record) return null;
    return this.preparedReviewResult(
      await this.reviewSource(artifact.id),
      record,
    );
  }

  private async reviewSource(
    artifactId: string,
  ): Promise<AgreementReviewSource> {
    const snapshot = await this.deps.repository.readExportSnapshot(artifactId);
    await this.readOwnerPdf({ artifactId, ownerEntityId: SELF_ENTITY_ID });
    const documents = this.deps.documents();
    if (!documents)
      throw new AgreementKnowledgeError(
        "Agreement document service is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
      );
    const document = await documents.getDocumentById(
      snapshot.artifact.documentId as UUID,
    );
    const raw =
      document?.metadata && "agreementExtractionJson" in document.metadata
        ? document.metadata.agreementExtractionJson
        : undefined;
    const ingestion = snapshot.audit.find(
      (event) => event.event_type === "agreement_ingested",
    );
    try {
      if (typeof raw !== "string" || !ingestion)
        throw new Error("Complete recorded extraction is required");
      const provenance = z
        .object({ extractionSha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(requiredText(ingestion.inputs_json, "inputs_json")));
      const extractionSha256 = crypto
        .createHash("sha256")
        .update(raw)
        .digest("hex");
      if (extractionSha256 !== provenance.extractionSha256)
        throw new Error("Extraction hash differs from ingestion provenance");
      const extraction = agreementExtractionSchema.parse(JSON.parse(raw));
      if (
        extraction.pageCount !== snapshot.artifact.pageCount ||
        extraction.pages.length !== extraction.pageCount ||
        extraction.pages.some((page, index) => page.pageNumber !== index + 1)
      )
        throw new Error("Extraction page map is incomplete");
      return {
        artifactId,
        sourceSha256: snapshot.artifact.contentSha256,
        extractionSha256,
        extraction,
      };
    } catch (cause) {
      // error-policy:J2 Refuse unverifiable source evidence before model dispatch.
      throw new AgreementKnowledgeError(
        "Agreement review requires a complete, integrity-verified extraction",
        "AGREEMENT_INVALID_CONTRACT",
        { artifactId },
        cause,
      );
    }
  }

  private async prepareOwnerReviewOnce(
    artifactId: string,
  ): Promise<PreparedAgreementReview> {
    const source = await this.reviewSource(artifactId);
    let record = await this.deps.repository.readPreparedReview(artifactId);
    if (!record) {
      const generated: GeneratedAgreementReview =
        await withStandaloneTrajectory(
          this.deps.runtime,
          {
            source: "lifeops.agreement-review",
            metadata: {
              artifactId,
              sourceSha256: source.sourceSha256,
              extractionSha256: source.extractionSha256,
            },
          },
          () => generateAgreementReview(this.deps.runtime, source),
        );
      const generatedAt = this.now().toISOString();
      const obligations: ParentingAgreementObligation[] =
        generated.proposals.map((proposal) => ({
          ...proposal,
          id: `haob_${crypto.randomUUID()}`,
          agentId: this.deps.agentId,
          artifactId,
          status: "proposed",
          proposedByEntityId: this.deps.agentId,
          decidedByEntityId: null,
          decisionReason: null,
          decidedAt: null,
          createdAt: generatedAt,
          updatedAt: generatedAt,
        }));
      record = await this.deps.repository.commitPreparedReview(
        {
          artifactId,
          sourceSha256: source.sourceSha256,
          extractionSha256: source.extractionSha256,
          generatedAt,
          explanation: generated.explanation,
          obligationIds: obligations.map((obligation) => obligation.id),
        },
        obligations,
      );
    }
    return this.preparedReviewResult(source, record);
  }

  private async preparedReviewResult(
    source: AgreementReviewSource,
    record: PreparedReviewRecord,
  ): Promise<PreparedAgreementReview> {
    const artifactId = source.artifactId;
    if (
      record.artifactId !== artifactId ||
      record.sourceSha256 !== source.sourceSha256 ||
      record.extractionSha256 !== source.extractionSha256
    ) {
      throw new AgreementKnowledgeError(
        "Prepared review does not match this immutable source",
        "AGREEMENT_INVALID_CONTRACT",
        { artifactId },
      );
    }
    const all = await this.deps.repository.listObligations(artifactId);
    const obligations = record.obligationIds.map((id) => {
      const obligation = all.find((item) => item.id === id);
      if (!obligation)
        throw new AgreementKnowledgeError(
          "Prepared review obligation is unavailable",
          "AGREEMENT_STORAGE_UNAVAILABLE",
          { artifactId, obligationId: id },
        );
      return obligation;
    });
    return {
      artifactId,
      generatedAt: record.generatedAt,
      explanation: record.explanation,
      outcome: obligations.length ? "proposals" : "no_proposals",
      obligations,
    };
  }

  private requireOwnerOrAgent(actorEntityId: string): void {
    if (
      actorEntityId !== SELF_ENTITY_ID &&
      actorEntityId !== this.deps.agentId
    ) {
      throw new AgreementKnowledgeError(
        "Only the owner or this agent may propose agreement obligations",
        "AGREEMENT_ACCESS_DENIED",
        { actorEntityId },
      );
    }
  }

  private async settleIngestionOperation(
    operationId: string,
    priorFailure?: unknown,
  ): Promise<void> {
    try {
      await settleFamilyWorkspaceOperation(this.deps.runtime, operationId);
    } catch (cause) {
      // error-policy:J2 A failed settlement cannot be reported as a completed upload.
      const failure = new AgreementKnowledgeError(
        "The ingestion operation could not be settled. Reconcile its claim before deletion or retry.",
        "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
        { operationId },
        priorFailure === undefined
          ? cause
          : new AggregateError([priorFailure, cause]),
      );
      this.deps.runtime.reportError("AgreementKnowledge.ingestion", failure);
      throw failure;
    }
  }

  private async requireArtifact(id: string) {
    await this.requireReadableWorkspace();
    const artifact = await this.deps.repository.getArtifact(
      normalizeHouseholdIdentifier(id, "artifactId"),
    );
    if (!artifact) {
      throw new AgreementKnowledgeError(
        "Parenting-agreement artifact was not found",
        "AGREEMENT_ARTIFACT_NOT_FOUND",
        { artifactId: id },
      );
    }
    await this.requireReadableWorkspace();
    return artifact;
  }

  async listOwnerAgreements(input: {
    ownerEntityId: string;
    householdId?: string;
  }): Promise<ParentingAgreementView[]> {
    this.requireOwner(input.ownerEntityId);
    await this.requireReadableWorkspace();
    const householdId = input.householdId
      ? normalizeHouseholdIdentifier(input.householdId, "householdId")
      : undefined;
    const artifacts = await this.deps.repository.listArtifacts(householdId);
    const views = await Promise.all(
      artifacts.map(async (artifact) => ({
        artifact,
        obligations: await this.deps.repository.listObligations(artifact.id),
      })),
    );
    await this.requireReadableWorkspace();
    return views;
  }

  async createAgreementVersion(input: {
    householdId?: string;
    agreementKey: string;
    title: string;
    originalFilename: string;
    mimeType: string;
    bytes: Buffer | Uint8Array;
    uploadedByEntityId: string;
  }): Promise<ParentingAgreementArtifact> {
    this.requireOwner(input.uploadedByEntityId);
    if (input.mimeType.trim().toLowerCase() !== "application/pdf") {
      throw new AgreementKnowledgeError(
        "Parenting agreements must be uploaded as PDF bytes",
        "AGREEMENT_INVALID_CONTRACT",
        { mimeType: input.mimeType },
      );
    }
    if (input.bytes.byteLength < 1) {
      throw new AgreementKnowledgeError(
        "Parenting agreement PDF must not be empty",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new AgreementKnowledgeError(
        "Parenting agreement bytes do not have a PDF signature",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    const householdId = normalizeHouseholdIdentifier(
      input.householdId ?? DEFAULT_HOUSEHOLD_ID,
      "householdId",
    );
    const agreementKey = nonEmpty(input.agreementKey, "agreementKey");
    const title = nonEmpty(input.title, "title");
    const originalFilename = nonEmpty(
      input.originalFilename,
      "originalFilename",
    );
    const expectedSha256 = crypto
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    const existing = await this.deps.repository.getArtifactByContent({
      householdId,
      agreementKey,
      contentSha256: expectedSha256,
    });
    if (existing) {
      throw new AgreementKnowledgeError(
        "This agreement content already exists as an immutable version",
        "AGREEMENT_DUPLICATE_CONTENT",
        { artifactId: existing.id, contentSha256: expectedSha256 },
      );
    }
    const fileStorage = this.deps.fileStorage();
    const documents = this.deps.documents();
    const pdf = this.deps.pdf();
    if (!fileStorage || !documents || !pdf) {
      throw new AgreementKnowledgeError(
        "The runtime file-storage, document, or PDF service is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
        {
          fileStorage: Boolean(fileStorage),
          documents: Boolean(documents),
          pdf: Boolean(pdf),
        },
      );
    }
    const artifactId = `hag_${crypto.randomUUID()}`;
    const operationId = await beginFamilyWorkspaceOperation(this.deps.runtime, {
      kind: "agreement-upload",
      artifactId,
      contentSha256: expectedSha256,
    });
    let extracted: PdfCompleteDocument;
    try {
      const ocr = await resolveAgreementOcr();
      extracted = await pdf.extractCompleteDocument(bytes, {
        ocrPage: ocr
          ? async ({ pageNumber, pngBytes }) => {
              const result = await ocr.describe({
                displayId: `agreement-pdf-page-${pageNumber}`,
                sourceX: 0,
                sourceY: 0,
                pngBytes,
              });
              return result.blocks.map((block) => block.text).join("\n");
            }
          : undefined,
      });
    } catch (error) {
      // error-policy:J2 Extraction has settled without creating persistent sources.
      await this.settleIngestionOperation(operationId, error);
      if (
        error instanceof ElizaError &&
        error.code === "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE"
      ) {
        this.deps.runtime.reportError(
          "AgreementKnowledge.extractCompleteDocument",
          error,
        );
        throw new AgreementSourceUnchangedError(
          "Document reading is temporarily unavailable. Check the model service, then retry this upload.",
          "AGREEMENT_EXTRACTION_UNAVAILABLE",
          error.context,
          error,
        );
      }
      throw new AgreementSourceUnchangedError(
        `The complete parenting-agreement PDF could not be extracted: ${error instanceof Error ? error.message : String(error)}`,
        "AGREEMENT_INVALID_CONTRACT",
        undefined,
        error,
      );
    }
    const pageCount = extracted.pageCount;
    const extractionJson = JSON.stringify(extracted);
    const extractionSha256 = crypto
      .createHash("sha256")
      .update(extractionJson)
      .digest("hex");
    let stored: Awaited<ReturnType<IFileStorageService["storePrivate"]>>;
    try {
      stored = await fileStorage.storePrivate(bytes, "application/pdf");
    } catch (cause) {
      // error-policy:J2 A lost acknowledgement may follow a durable write; retain its claim and source.
      const failure = new AgreementKnowledgeError(
        "Private PDF persistence could not be confirmed. Reconcile the source identity before retrying or deleting its claim.",
        "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
        { operationId, artifactId, contentSha256: expectedSha256 },
        cause,
      );
      this.deps.runtime.reportError("AgreementKnowledge.ingestion", failure);
      throw failure;
    }
    let documentId: UUID | null = null;
    try {
      if (
        stored.hash !== expectedSha256 ||
        !stored.fileName.startsWith(`${expectedSha256}.`) ||
        stored.size !== bytes.byteLength
      ) {
        throw new AgreementKnowledgeError(
          "File storage returned metadata that does not match the agreement bytes",
          "AGREEMENT_INVALID_CONTRACT",
          { expectedSha256, storedHash: stored.hash },
        );
      }
      const document = await documents.addDocument({
        agentId: this.deps.agentId as UUID,
        worldId: this.deps.agentId as UUID,
        roomId: this.deps.agentId as UUID,
        entityId: this.deps.agentId as UUID,
        clientDocumentId: "" as UUID,
        contentType: "text/plain",
        // Each immutable artifact owns its document lifecycle, even when the
        // same PDF is uploaded concurrently or into another agreement family.
        originalFilename: `${stored.hash}.${artifactId}.txt`,
        content: [
          `Parenting agreement: ${title}`,
          `Source PDF: ${originalFilename}`,
          `Content SHA-256: ${stored.hash}`,
          `Pages: ${pageCount}`,
          "",
          extracted.text,
          "",
          "Agreement obligations are inactive until the owner approves their page-cited review records.",
        ].join("\n"),
        scope: "owner-private",
        addedBy: this.deps.agentId as UUID,
        addedByRole: "RUNTIME",
        addedFrom: "lifeops",
        pinned: false,
        metadata: {
          source: "lifeops.parenting-agreement",
          title,
          originalFilename,
          contentType: "application/pdf",
          mediaUrl: `/api/lifeops/agreements/${artifactId}/download`,
          mediaHash: stored.hash,
          mediaFileName: stored.fileName,
          agreementKey,
          householdId,
          agreementExtractionJson: extractionJson,
        },
      });
      documentId = document.storedDocumentMemoryId;
      const artifact = await this.deps.repository.insertArtifact({
        id: artifactId,
        agentId: this.deps.agentId,
        householdId,
        agreementKey,
        supersedesArtifactId: null,
        title,
        originalFilename,
        documentId: document.storedDocumentMemoryId,
        mediaUrl: `/api/lifeops/agreements/${artifactId}/download`,
        mediaFileName: stored.fileName,
        contentSha256: stored.hash,
        mimeType: stored.mimeType,
        byteSize: stored.size,
        pageCount,
        uploadedByEntityId: input.uploadedByEntityId,
        extractionSha256,
        createdAt: this.now().toISOString(),
      });
      await this.settleIngestionOperation(operationId);
      return artifact;
    } catch (error) {
      // error-policy:J2 Roll back only this attempt; preserve committed or uncertain sources.
      if (documentId) {
        let persisted: ParentingAgreementArtifact | null;
        try {
          persisted = await this.deps.repository.getArtifact(artifactId);
        } catch (reconciliationError) {
          // error-policy:J2 A failed commit observation cannot authorize source deletion.
          const failure = new AgreementKnowledgeError(
            "Upload persistence could not be reconciled. Inspect the artifact before retrying or deleting its sources.",
            "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
            {
              artifactId,
              documentId,
              mediaFileName: stored.fileName,
              operationId,
            },
            new AggregateError([error, reconciliationError]),
          );
          this.deps.runtime.reportError(
            "AgreementKnowledge.ingestion",
            failure,
          );
          throw failure;
        }
        if (persisted) {
          const failure = new AgreementKnowledgeError(
            "The agreement was persisted but the upload did not finish normally. Review the existing version before retrying.",
            "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
            {
              artifactId,
              documentId,
              mediaFileName: stored.fileName,
              operationId,
            },
            error,
          );
          this.deps.runtime.reportError(
            "AgreementKnowledge.ingestion",
            failure,
          );
          throw failure;
        }
      }
      const cleanup = await Promise.allSettled([
        ...(documentId
          ? [
              documents.deleteDocumentWithAccessContext(documentId, {
                // requireOwner already verified SELF; documents use the runtime UUID.
                requesterEntityId: this.deps.agentId as UUID,
                role: "OWNER",
                isOwner: true,
              }),
            ]
          : []),
        fileStorage.deletePrivate(stored.fileName),
      ]);
      const failures = cleanup.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length > 0) {
        const failure = new AgreementKnowledgeError(
          "The upload failed and its private-source cleanup is incomplete. Resolve the reported storage failures before retrying.",
          "AGREEMENT_INGESTION_CLEANUP_FAILED",
          {
            artifactId,
            documentId,
            mediaFileName: stored.fileName,
            operationId,
          },
          new AggregateError([
            error,
            ...failures.map((result) => result.reason),
          ]),
        );
        this.deps.runtime.reportError("AgreementKnowledge.ingestion", failure);
        throw failure;
      }
      await this.settleIngestionOperation(operationId, error);
      throw error;
    }
  }

  async readOwnerPdf(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const fileStorage = this.deps.fileStorage();
    if (!fileStorage) {
      throw new AgreementKnowledgeError(
        "The runtime private file-storage service is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
      );
    }
    const bytes = await fileStorage.readPrivate(artifact.mediaFileName);
    if (!bytes) {
      throw new AgreementKnowledgeError(
        "The immutable parenting-agreement PDF is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
        { artifactId: artifact.id },
      );
    }
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== artifact.contentSha256 || bytes.length !== artifact.byteSize) {
      throw new AgreementKnowledgeError(
        "The immutable parenting-agreement PDF failed integrity verification",
        "AGREEMENT_INVALID_CONTRACT",
        { artifactId: artifact.id },
      );
    }
    await this.requireReadableWorkspace();
    return {
      bytes,
      mimeType: artifact.mimeType,
      fileName: artifact.originalFilename,
    };
  }

  async exportOwnerAgreement(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
    this.requireOwner(input.ownerEntityId);
    // Verify immutable bytes before recording a prepared export. Mutable review,
    // pin, and grant state is subsequently captured in a single SQL snapshot.
    const original = await this.readOwnerPdf(input);
    const snapshot = await this.deps.repository.readExportSnapshot(
      input.artifactId,
    );
    const documents = this.deps.documents();
    if (!documents)
      throw new AgreementKnowledgeError(
        "Agreement document service is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
      );
    const document = await documents.getDocumentById(
      snapshot.artifact.documentId as UUID,
    );
    if (!document)
      throw new AgreementKnowledgeError(
        "Agreement extraction document is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
        { artifactId: input.artifactId },
      );
    const extractionJson =
      document.metadata && "agreementExtractionJson" in document.metadata
        ? document.metadata.agreementExtractionJson
        : undefined;
    let extractionBytes: Buffer | null = null;
    let extraction:
      | {
          status: "available";
          path: "extraction.json";
          sha256: string;
          pageCount: number;
        }
      | { status: "unavailable"; reason: string };
    const ingestion = snapshot.audit.find(
      (event) => event.event_type === "agreement_ingested",
    );
    let recordedExtractionSha256: string | null = null;
    if (ingestion) {
      try {
        const inputs = z
          .object({ extractionSha256: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(
            JSON.parse(requiredText(ingestion.inputs_json, "inputs_json")),
          );
        recordedExtractionSha256 = inputs.extractionSha256;
      } catch (error) {
        // error-policy:J2 Recorded ingestion provenance must remain verifiable.
        throw new AgreementKnowledgeError(
          "Agreement ingestion provenance is invalid",
          "AGREEMENT_INVALID_CONTRACT",
          { artifactId: input.artifactId },
          error,
        );
      }
    }
    if (
      recordedExtractionSha256 &&
      (typeof extractionJson !== "string" ||
        crypto.createHash("sha256").update(extractionJson).digest("hex") !==
          recordedExtractionSha256)
    ) {
      throw new AgreementKnowledgeError(
        "Agreement extraction failed integrity verification",
        "AGREEMENT_INVALID_CONTRACT",
        { artifactId: input.artifactId },
      );
    }
    if (extractionJson === undefined) {
      extraction = {
        status: "unavailable",
        reason:
          "This version predates persisted extraction page maps; no historical extraction has been reconstructed.",
      };
    } else {
      try {
        if (typeof extractionJson !== "string")
          throw new Error("Extraction metadata is not serialized JSON");
        const parsed = agreementExtractionSchema.parse(
          JSON.parse(extractionJson),
        );
        if (
          parsed.pageCount !== snapshot.artifact.pageCount ||
          parsed.pages.length !== parsed.pageCount ||
          parsed.pages.some((page, index) => page.pageNumber !== index + 1)
        )
          throw new Error("Extraction page map is incomplete");
        // Export the exact serialized bytes bound at ingestion. Re-encoding
        // the validated object could change key order and invalidate that hash.
        extractionBytes = Buffer.from(extractionJson, "utf8");
        extraction = {
          status: "available",
          path: "extraction.json",
          sha256: crypto
            .createHash("sha256")
            .update(extractionBytes)
            .digest("hex"),
          pageCount: parsed.pageCount,
        };
      } catch (error) {
        // error-policy:J2 Invalid saved provenance must fail export visibly.
        throw new AgreementKnowledgeError(
          "Agreement extraction provenance is invalid",
          "AGREEMENT_INVALID_CONTRACT",
          { artifactId: input.artifactId },
          error,
        );
      }
    }
    const exportId = `agreement_export_${crypto.randomUUID()}`;
    const createdAt = this.now().toISOString();
    const manifest = Buffer.from(
      `${JSON.stringify(
        {
          schema: "elizaos.agreement-export",
          schemaVersion: 1,
          exportId,
          createdAt,
          original: {
            path: "original.pdf",
            sha256: snapshot.artifact.contentSha256,
            byteSize: snapshot.artifact.byteSize,
          },
          ...snapshot,
          extraction,
          auditCoverage: {
            status: snapshot.audit.some(
              (event) => event.event_type === "agreement_ingested",
            )
              ? "recorded_from_ingestion"
              : "partial_legacy_history",
            scope:
              "Persisted agreement events through the database snapshot. Earlier unrecorded activity is unavailable. This export preparation is recorded after archive construction; successful client receipt is not asserted.",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const manifestSha256 = crypto
      .createHash("sha256")
      .update(manifest)
      .digest("hex");
    const bytes = createZipArchive([
      { name: "original.pdf", data: original.bytes },
      { name: "manifest.json", data: manifest },
      ...(extractionBytes
        ? [{ name: "extraction.json", data: extractionBytes }]
        : []),
      {
        name: "SHA256SUMS",
        data: `${snapshot.artifact.contentSha256}  original.pdf\n${manifestSha256}  manifest.json\n${extraction.status === "available" ? `${extraction.sha256}  extraction.json\n` : ""}`,
      },
    ]);
    await this.deps.repository.recordExport({
      artifact: snapshot.artifact,
      exportId,
      ownerEntityId: input.ownerEntityId,
      createdAt,
      manifestSha256,
      archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
    await this.requireReadableWorkspace();
    return {
      bytes,
      mimeType: "application/zip",
      fileName: `agreement-${snapshot.artifact.id}-v${snapshot.artifact.version}.zip`,
    };
  }

  /** Adds an owner correction as an unapproved proposal; identical retries recover its current decision. */
  async addOwnerReviewProposal(input: {
    artifactId: string;
    ownerEntityId: string;
    proposal: AgreementReviewProposal;
  }): Promise<{ obligation: ParentingAgreementObligation; created: boolean }> {
    this.requireOwner(input.ownerEntityId);
    const artifactId = normalizeHouseholdIdentifier(
      input.artifactId,
      "artifactId",
    );
    const source = await this.reviewSource(artifactId);
    const proposal = validateAgreementReviewProposal(input.proposal, source);
    const identity = crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          "owner-agreement-proposal-v1",
          this.deps.agentId,
          artifactId,
          proposal.title,
          proposal.obligationText,
          proposal.pageStart,
          proposal.pageEnd,
          proposal.citationText,
        ]),
      )
      .digest("hex");
    const now = this.now().toISOString();
    return this.deps.repository.insertOwnerProposalOnce({
      ...proposal,
      id: `haob_owner_${identity}`,
      agentId: this.deps.agentId,
      artifactId,
      status: "proposed",
      proposedByEntityId: SELF_ENTITY_ID,
      decidedByEntityId: null,
      decisionReason: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async proposeObligation(input: {
    artifactId: string;
    title: string;
    obligationText: string;
    pageStart: number;
    pageEnd?: number;
    citationText: string;
    proposedByEntityId: string;
  }): Promise<ParentingAgreementObligation> {
    this.requireOwnerOrAgent(input.proposedByEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const pageStart = requirePositiveInteger(input.pageStart, "pageStart");
    const pageEnd = requirePositiveInteger(
      input.pageEnd ?? pageStart,
      "pageEnd",
    );
    if (pageEnd < pageStart || pageEnd > artifact.pageCount) {
      throw new AgreementKnowledgeError(
        "Obligation citation pages must be ordered and inside the source PDF",
        "AGREEMENT_INVALID_CONTRACT",
        { pageStart, pageEnd, pageCount: artifact.pageCount },
      );
    }
    const now = this.now().toISOString();
    return await this.deps.repository.insertObligation({
      id: `haob_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      artifactId: artifact.id,
      title: nonEmpty(input.title, "title"),
      obligationText: nonEmpty(input.obligationText, "obligationText"),
      pageStart,
      pageEnd,
      citationText: nonEmpty(input.citationText, "citationText"),
      status: "proposed",
      proposedByEntityId: input.proposedByEntityId,
      decidedByEntityId: null,
      decisionReason: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async decideObligation(input: {
    obligationId: string;
    decision: "approve" | "reject";
    decidedByEntityId: string;
    reason: string;
  }): Promise<ParentingAgreementObligation> {
    this.requireOwner(input.decidedByEntityId);
    return await this.deps.repository.decideObligation({
      obligationId: normalizeHouseholdIdentifier(
        input.obligationId,
        "obligationId",
      ),
      status: input.decision === "approve" ? "approved" : "rejected",
      decidedByEntityId: input.decidedByEntityId,
      decisionReason: nonEmpty(input.reason, "reason"),
      decidedAt: this.now().toISOString(),
    });
  }

  /** Lists only conversations in this agent's current participant set. */
  async listPinTargets(ownerEntityId: string): Promise<AgreementPinTargets> {
    this.requireOwner(ownerEntityId);
    const runtime = this.deps.runtime;
    const ids = await runtime.getRoomsForParticipant(runtime.agentId);
    const chats: Array<{ id: string; name: string | null; source: string }> =
      [];
    const conversational = new Set<ChannelType>([
      ChannelType.DM,
      ChannelType.GROUP,
      ChannelType.THREAD,
      ChannelType.VOICE_DM,
      ChannelType.VOICE_GROUP,
      ChannelType.API,
    ]);
    for (const id of ids) {
      const room = await runtime.getRoom(id);
      if (
        room &&
        room.agentId === runtime.agentId &&
        conversational.has(room.type)
      )
        chats.push({
          id: room.id,
          name: room.name?.trim() || null,
          source: room.source,
        });
    }
    chats.sort(
      (left, right) =>
        (left.name ?? "").localeCompare(right.name ?? "") ||
        left.id.localeCompare(right.id),
    );
    return {
      agent: {
        id: runtime.agentId,
        name: runtime.character.name?.trim() || null,
      },
      chats,
    };
  }

  async pin(input: {
    artifactId: string;
    targetType: KnowledgePinTargetType;
    targetId: string;
    pinnedByEntityId: string;
  }): Promise<HouseholdKnowledgePin> {
    this.requireOwner(input.pinnedByEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const targetId = nonEmpty(input.targetId, "targetId");
    const targets = await this.listPinTargets(input.pinnedByEntityId);
    const valid =
      input.targetType === "agent"
        ? targetId === targets.agent.id
        : input.targetType === "chat" &&
          targets.chats.some((chat) => chat.id === targetId);
    if (!valid) {
      throw new AgreementKnowledgeError(
        "This pin destination is unavailable. Refresh the choices and select this agent or one of its current conversations.",
        "AGREEMENT_INVALID_CONTRACT",
        { targetType: input.targetType, targetId },
      );
    }
    return await this.deps.repository.setPin({
      artifactId: artifact.id,
      targetType: input.targetType,
      targetId,
      pinnedByEntityId: input.pinnedByEntityId,
      pinnedAt: this.now().toISOString(),
    });
  }

  async listPins(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<HouseholdKnowledgePin[]> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    return await this.deps.repository.listPins(artifact.id);
  }

  async unpin(input: {
    pinId: string;
    unpinnedByEntityId: string;
  }): Promise<HouseholdKnowledgePin> {
    this.requireOwner(input.unpinnedByEntityId);
    return await this.deps.repository.removePin({
      pinId: normalizeHouseholdIdentifier(input.pinId, "pinId"),
      unpinnedByEntityId: input.unpinnedByEntityId,
      unpinnedAt: this.now().toISOString(),
    });
  }

  async listGuestAccessOptions(input: {
    artifactId: string;
    ownerEntityId: string;
  }): Promise<AgreementGuestAccessOptions> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const options: AgreementGuestAccessOptions = { candidates: [], grants: [] };
    const householdGrants = await this.deps.household.listActiveGrantsForOwner({
      householdId: artifact.householdId,
      ownerEntityId: input.ownerEntityId,
      scope: "knowledge.read",
    });
    for (const grant of householdGrants) {
      if (grant.principalEntityId === SELF_ENTITY_ID) continue;
      const principal = await this.deps.entityStore.get(
        grant.principalEntityId,
      );
      const identity = principal?.identities.find((item) => item.verified);
      if (!principal || !identity) continue;
      options.candidates.push({
        principalEntityId: grant.principalEntityId,
        householdGrantId: grant.id,
        displayName: principal.preferredName || null,
        identityLabel: `${identity.platform}: ${identity.handle}`,
        role: grant.role,
        expiresAt: grant.expiresAt,
        issuedAt: grant.createdAt,
      });
    }
    for (const grant of await this.deps.repository.listArtifactGrants(
      artifact.id,
    )) {
      if (grant.revokedAt) continue;
      const principal = await this.deps.entityStore.get(
        grant.principalEntityId,
      );
      const preview = await this.previewGuestRead({
        artifactId: artifact.id,
        principalEntityId: grant.principalEntityId,
        householdGrantId: grant.householdGrantId,
        ownerEntityId: input.ownerEntityId,
      });
      options.grants.push({
        grantId: grant.id,
        principalEntityId: grant.principalEntityId,
        householdGrantId: grant.householdGrantId,
        displayName: principal?.preferredName || null,
        issuedAt: grant.createdAt,
        canRead: preview.allowed,
        denial: preview.denial?.message ?? null,
      });
    }
    return options;
  }

  async previewGuestRead(input: {
    artifactId: string;
    principalEntityId: string;
    householdGrantId: string;
    ownerEntityId: string;
  }): Promise<AgreementGuestGrantPreview> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const householdGrantId = normalizeHouseholdIdentifier(
      input.householdGrantId,
      "householdGrantId",
    );
    const base = {
      artifactId: artifact.id,
      principalEntityId,
      householdGrantId,
      effects: ["read_artifact_metadata", "read_approved_obligations"] as const,
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ] as const,
    };
    const principal = await this.deps.entityStore.get(principalEntityId);
    if (!principal?.identities.some((identity) => identity.verified)) {
      return {
        ...base,
        allowed: false,
        denial: {
          code: "AGREEMENT_ACCESS_DENIED",
          message: "Guest requires a verified identity",
        },
      };
    }
    try {
      await this.deps.household.requireGrantActive({
        householdId: artifact.householdId,
        grantId: householdGrantId,
        principalEntityId,
        scope: "knowledge.read",
        at: this.now(),
      });
      return { ...base, allowed: true, denial: null };
    } catch (error) {
      if (!(error instanceof HouseholdCoordinationError)) throw error;
      return {
        ...base,
        allowed: false,
        denial: {
          code: "AGREEMENT_ACCESS_DENIED",
          message: error.message,
        },
      };
    }
  }

  async activePinnedContext(input: {
    ownerEntityId: string;
    roomId?: string;
  }): Promise<ParentingAgreementView[]> {
    this.requireOwner(input.ownerEntityId);
    await this.requireReadableWorkspace();
    const targets: Array<{
      targetType: KnowledgePinTargetType;
      targetId: string;
    }> = [{ targetType: "agent", targetId: this.deps.agentId }];
    if (input.roomId) {
      targets.push({
        targetType: "chat",
        targetId: normalizeHouseholdIdentifier(input.roomId, "roomId"),
      });
    }
    const pins = await this.deps.repository.listActivePinsForTargets(targets);
    const artifactIds = [...new Set(pins.map((pin) => pin.artifactId))];
    const views: ParentingAgreementView[] = [];
    for (const artifactId of artifactIds) {
      const artifact = await this.requireArtifact(artifactId);
      const obligations = (
        await this.deps.repository.listObligations(artifact.id)
      ).filter((obligation) => obligation.status === "approved");
      if (obligations.length > 0) views.push({ artifact, obligations });
    }
    await this.requireReadableWorkspace();
    return views;
  }

  /**
   * Resolve active pins through the requesting principal's current resource
   * grants. Owner callers retain the complete owner view; guests receive only
   * the safe projection from `readFor`, and a pin never turns a denial into
   * access.
   */
  async activePinnedContextForPrincipal(input: {
    principalEntityId: string;
    roomId?: string;
    at?: Date;
  }): Promise<Array<ParentingAgreementView | ParentingAgreementGuestView>> {
    await this.requireReadableWorkspace();
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    if (principalEntityId === SELF_ENTITY_ID) {
      return this.activePinnedContext({
        ownerEntityId: SELF_ENTITY_ID,
        ...(input.roomId ? { roomId: input.roomId } : {}),
      });
    }
    const targets: Array<{
      targetType: KnowledgePinTargetType;
      targetId: string;
    }> = [{ targetType: "agent", targetId: this.deps.agentId }];
    if (input.roomId) {
      targets.push({
        targetType: "chat",
        targetId: normalizeHouseholdIdentifier(input.roomId, "roomId"),
      });
    }
    const pins = await this.deps.repository.listActivePinsForTargets(targets);
    const artifactIds = [...new Set(pins.map((pin) => pin.artifactId))];
    const views: ParentingAgreementGuestView[] = [];
    for (const artifactId of artifactIds) {
      try {
        const view = await this.readFor({
          artifactId,
          principalEntityId,
          ...(input.at ? { at: input.at } : {}),
        });
        if ("contentSha256" in view.artifact) {
          throw new AgreementKnowledgeError(
            "Guest pin projection unexpectedly resolved owner knowledge",
            "AGREEMENT_ACCESS_DENIED",
            { artifactId, principalEntityId },
          );
        }
        views.push(view);
      } catch (error) {
        if (
          error instanceof AgreementKnowledgeError &&
          error.code === "AGREEMENT_ACCESS_DENIED"
        ) {
          // error-policy:J4 A pin is discovery metadata, never authorization.
          // Omit an inaccessible artifact while independently evaluating peers.
          continue;
        }
        throw error;
      }
    }
    await this.requireReadableWorkspace();
    return views;
  }

  async grantGuestRead(input: {
    artifactId: string;
    principalEntityId: string;
    householdGrantId: string;
    issuedByEntityId: string;
  }): Promise<HouseholdKnowledgeGrant> {
    this.requireOwner(input.issuedByEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const principal = await this.deps.entityStore.get(principalEntityId);
    if (!principal?.identities.some((identity) => identity.verified)) {
      throw new AgreementKnowledgeError(
        "Agreement guests require at least one verified identity",
        "AGREEMENT_ACCESS_DENIED",
        { principalEntityId },
      );
    }
    await this.deps.household.requireGrantActive({
      householdId: artifact.householdId,
      grantId: input.householdGrantId,
      principalEntityId,
      scope: "knowledge.read",
      at: this.now(),
    });
    const now = this.now().toISOString();
    return await this.deps.repository.upsertGrant({
      id: `hkgrant_${crypto.randomUUID()}`,
      agentId: this.deps.agentId,
      householdId: artifact.householdId,
      artifactId: artifact.id,
      principalEntityId,
      householdGrantId: input.householdGrantId,
      issuedByEntityId: input.issuedByEntityId,
      revokedAt: null,
      revokedByEntityId: null,
      revocationReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Owner-only recipient ACL projection for downstream share drafts. */
  async listActiveGuestPrincipals(input: {
    artifactId: string;
    ownerEntityId: string;
    at?: Date;
  }): Promise<string[]> {
    this.requireOwner(input.ownerEntityId);
    const artifact = await this.requireArtifact(input.artifactId);
    const allowed: string[] = [];
    for (const grant of await this.deps.repository.listArtifactGrants(
      artifact.id,
    )) {
      if (grant.revokedAt) continue;
      try {
        await this.deps.household.requireGrantActive({
          householdId: artifact.householdId,
          grantId: grant.householdGrantId,
          principalEntityId: grant.principalEntityId,
          scope: "knowledge.read",
          at: input.at ?? this.now(),
        });
        allowed.push(grant.principalEntityId);
      } catch (error) {
        if (!(error instanceof HouseholdCoordinationError)) throw error;
        // error-policy:J4 inactive household grants are omitted from the
        // explicit downstream ACL instead of being presented as active.
      }
    }
    return [...new Set(allowed)].sort();
  }

  async revokeGuestRead(input: {
    grantId: string;
    revokedByEntityId: string;
    reason: string;
  }): Promise<HouseholdKnowledgeGrant> {
    this.requireOwner(input.revokedByEntityId);
    return await this.deps.repository.revokeGrant({
      grantId: normalizeHouseholdIdentifier(input.grantId, "grantId"),
      revokedByEntityId: input.revokedByEntityId,
      reason: nonEmpty(input.reason, "reason"),
      revokedAt: this.now().toISOString(),
    });
  }

  async readFor(input: {
    artifactId: string;
    principalEntityId: string;
    at?: Date;
  }): Promise<ParentingAgreementView | ParentingAgreementGuestView> {
    const artifact = await this.requireArtifact(input.artifactId);
    const principalEntityId = normalizeHouseholdIdentifier(
      input.principalEntityId,
      "principalEntityId",
    );
    const obligations = await this.deps.repository.listObligations(artifact.id);
    if (principalEntityId === SELF_ENTITY_ID) {
      await this.requireReadableWorkspace();
      return { artifact, obligations };
    }
    const grants = await this.deps.repository.listGrants(
      artifact.id,
      principalEntityId,
    );
    for (const grant of grants) {
      if (grant.revokedAt) continue;
      try {
        await this.deps.household.requireGrantActive({
          householdId: artifact.householdId,
          grantId: grant.householdGrantId,
          principalEntityId,
          scope: "knowledge.read",
          at: input.at ?? this.now(),
        });
        await this.requireReadableWorkspace();
        return {
          artifact: guestArtifactProjection(artifact),
          obligations: obligations
            .filter((obligation) => obligation.status === "approved")
            .map(guestObligationProjection),
        };
      } catch (error) {
        if (!(error instanceof HouseholdCoordinationError)) throw error;
        // error-policy:J4 A stale resource binding is an explicit denied read;
        // another independently active binding may still authorize the same
        // principal, so evaluate every exact candidate before failing closed.
      }
    }
    throw new AgreementKnowledgeError(
      "The principal has no active grant for this agreement version",
      "AGREEMENT_ACCESS_DENIED",
      { artifactId: artifact.id, principalEntityId },
    );
  }
}

export function createAgreementKnowledgeService(
  runtime: IAgentRuntime,
  now?: () => Date,
): AgreementKnowledgeService {
  const graph = resolveKnowledgeGraphService(runtime);
  const household = getHouseholdCoordinationService(runtime);
  if (!graph || !household) {
    throw new AgreementKnowledgeError(
      "Agreement knowledge requires graph and household services",
      "AGREEMENT_STORAGE_UNAVAILABLE",
      {
        graph: Boolean(graph),
        household: Boolean(household),
      },
    );
  }
  return new AgreementKnowledgeService({
    runtime,
    agentId: runtime.agentId,
    entityStore: graph.getEntityStore(runtime.agentId),
    household,
    repository: new AgreementKnowledgeRepository(runtime, runtime.agentId),
    fileStorage: () =>
      runtime.getService<IFileStorageService>(ServiceType.REMOTE_FILES),
    documents: () =>
      runtime.getService<DocumentService>(DocumentService.serviceType),
    pdf: () => runtime.getService<PdfService>(ServiceType.PDF),
    now,
  });
}

export class AgreementKnowledgeRuntimeService extends Service {
  static override serviceType = HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE;
  override capabilityDescription =
    "Immutable parenting-agreement versions, reviewed citations, pins, and bounded guest reads";

  readonly agreements: AgreementKnowledgeService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new AgreementKnowledgeError(
        "AgreementKnowledgeRuntimeService requires a runtime",
        "AGREEMENT_INVALID_CONTRACT",
      );
    }
    this.agreements = createAgreementKnowledgeService(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    await Promise.all([
      runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE),
      runtime.getServiceLoadPromise(HOUSEHOLD_COORDINATION_SERVICE),
    ]);
    return new AgreementKnowledgeRuntimeService(runtime);
  }

  async stop(): Promise<void> {}
}

export function getAgreementKnowledgeService(
  runtime: IAgentRuntime,
): AgreementKnowledgeService | null {
  return (
    runtime.getService<AgreementKnowledgeRuntimeService>(
      HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE,
    )?.agreements ?? null
  );
}
