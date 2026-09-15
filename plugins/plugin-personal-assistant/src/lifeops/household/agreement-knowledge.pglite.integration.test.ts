/**
 * Real-PGlite behavioral coverage for immutable agreement knowledge. The
 * runtime uses the production graph, household authorization, migrations, and
 * content-addressed file service. PDF extraction is a deterministic boundary
 * fixture, including explicit transcription failures; this is not live OCR proof.
 */

import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { createLocalAgentBackup } from "@elizaos/agent/services/agent-backup";
import { withAgentBackupAuthority } from "@elizaos/agent/services/agent-backup-authority";
import { AuthStore } from "@elizaos/app-core/services/auth-store";
import {
  type AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  ChannelType,
  DocumentService,
  documentsPluginCore,
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  type Memory,
  ModelType,
  type Plugin,
  Service,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type { PdfService } from "@elizaos/plugin-pdf";
import {
  getScheduledTaskRunner,
  registerScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectReferencedMedia } from "../../../../../packages/agent/src/api/media-runtime.ts";
import { gcUnreferencedMedia } from "../../../../../packages/agent/src/api/media-store.ts";
import { tryHandleRuntimePluginRoute } from "../../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { LocalFileStorageService } from "../../../../../packages/agent/src/services/file-storage.js";
import {
  createBrowserSession,
  createMachineSession,
} from "../../../../../packages/app-core/src/api/auth/sessions.ts";
import { composeResponseState } from "../../../../../packages/core/src/services/message/provider-state.js";
import { TrajectoriesService } from "../../../../../packages/core/src/services/trajectories.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { agreementPinsProvider } from "../../providers/agreement-pins.js";
import { bindMachineAuthIdentityToEntity } from "../../routes/authenticated-entity-principal.js";
import { CalendarCardAccessStore } from "../calendar-card.js";
import { importFamilyCorrespondence } from "../family-coordination/intake-import.js";
import { FamilyIntakeReviewStore } from "../family-coordination/intake-review.js";
import { MonthlyFamilyPacketService } from "../family-coordination/monthly-packet.js";
import {
  ensureFamilyBackupCleanupSchedule,
  FAMILY_BACKUP_CLEANUP_OPERATION,
} from "../family-workflows/backup-cleanup-schedule.js";
import {
  previewFamilyDeletionDatabase,
  withReviewedFamilyDeletionDatabase,
} from "../family-workflows/deletion-database-snapshot.js";
import {
  admitFamilyBackupCleanup,
  beginFamilyWorkspaceDeletion,
  previewFamilyBackupCleanup,
  purgeFamilyBackupCleanup,
  purgeFamilyWorkspaceFiles,
  readFamilyDeletionJob,
} from "../family-workflows/workspace-deletion.js";
import { exportFamilyWorkspace } from "../family-workflows/workspace-export.js";
import {
  beginFamilyWorkspaceOperation,
  ensureFamilyWorkspaceOperationStore,
  fenceFamilyWorkspace,
  settleFamilyWorkspaceOperation,
} from "../family-workflows/workspace-operation-store.js";
import {
  CONCORD_SCHOOL_CALENDAR_SOURCE,
  SchoolCalendarWorkflow,
} from "../school/calendar-workflow.js";
import { executeRawSql, executeRawSqlTx, sqlQuote } from "../sql.js";
import {
  previewAgreementDeletion,
  withReviewedAgreementDeletion,
} from "./agreement-deletion-snapshot.js";
import {
  AgreementKnowledgeError,
  AgreementKnowledgeRepository,
  AgreementKnowledgeService,
  createAgreementKnowledgeService,
  type ParentingAgreementArtifact,
} from "./agreement-knowledge.js";
import {
  acceptAgreementChunk,
  beginAgreementUpload,
  commitAgreementUpload,
  readAgreementUpload,
} from "./agreement-upload-session.js";
import { ensureHouseholdGrantExpiryWarning } from "./grant-expiry-warning.js";
import { HouseholdCoordinationRepository } from "./repository.js";
import {
  getHouseholdCoordinationService,
  type HouseholdCoordinationService,
} from "./service.js";
import { DEFAULT_HOUSEHOLD_ID } from "./types.js";

const fileStoragePlugin: Plugin = {
  name: "agreement-knowledge-test-file-storage",
  description: "Production content-addressed file storage for agreement tests.",
  services: [LocalFileStorageService],
};

class AgreementTestPdfService extends Service {
  static override serviceType = ServiceType.PDF;

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<AgreementTestPdfService> {
    return new AgreementTestPdfService(runtime);
  }

  override capabilityDescription =
    "Deterministic complete PDF extraction for agreement domain tests";

  async stop(): Promise<void> {}

  transcriptionFailure: Error | null = null;

  async extractCompleteDocument(bytes: Buffer | Uint8Array) {
    if (this.transcriptionFailure) throw this.transcriptionFailure;
    const text = Buffer.from(bytes).toString("utf8");
    return {
      complete: true as const,
      pageCount: 12,
      pages: Array.from({ length: 12 }, (_, index) => ({
        pageNumber: index + 1,
        width: 612,
        height: 792,
        method: "native" as const,
        nativeText: text,
        nativePositionedText: [],
        ocrText: null,
        visionText: null,
        text,
        hasVisualContent: false,
      })),
      text: Array.from(
        { length: 12 },
        (_, index) => `--- Page ${index + 1} ---\n${text}`,
      ).join("\n\n"),
    };
  }
}

function pdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${label}\n%%EOF\n`, "utf8");
}

function readStoredZip(bytes: Buffer): Map<string, Buffer> {
  // Independently read ZIP local records rather than using the archive writer.
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    if (bytes.readUInt16LE(offset + 8) !== 0)
      throw new Error("Unsupported ZIP method");
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameSize + extraSize;
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameSize)
      .toString("utf8");
    files.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return files;
}

describe("parenting-agreement knowledge — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let household: HouseholdCoordinationService;
  let artifact: ParentingAgreementArtifact;
  let guestHouseholdGrantId: string;
  let mediaStateDir: string;
  const familyRoomId = crypto.randomUUID() as UUID;

  async function createPinRoom(id: UUID): Promise<void> {
    await runtime.createRoom({
      id,
      agentId: runtime.agentId,
      name: "Family planning",
      source: "test",
      type: ChannelType.GROUP,
      worldId: runtime.agentId,
    });
    await runtime.addParticipant(runtime.agentId, id);
  }
  let syntheticSchedulerDispatches = 0;

  beforeAll(async () => {
    mediaStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agreement-knowledge-media-"),
    );
    process.env.ELIZA_STATE_DIR = mediaStateDir;
    runtimeResult = await createLifeOpsTestRuntime({
      plugins: [fileStoragePlugin, documentsPluginCore],
    });
    runtime = runtimeResult.runtime;
    await createPinRoom(familyRoomId);
    runtime.services.set(ServiceType.PDF, [
      new AgreementTestPdfService(runtime),
    ]);
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const entities = graph.getEntityStore(runtime.agentId);
    await entities.ensureSelf();
    await entities.upsert({
      entityId: "child-one",
      type: "person",
      preferredName: "Child One",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
    });
    await entities.upsert({
      entityId: "verified-co-parent",
      type: "person",
      preferredName: "Verified Co-parent",
      identities: [
        {
          platform: "imessage",
          handle: "+15555550101",
          verified: true,
          confidence: 1,
          addedAt: "2026-01-01T00:00:00.000Z",
          addedVia: "user_chat",
          evidence: ["Owner verified the co-parent's iMessage identity."],
        },
      ],
      tags: [],
      visibility: "owner_only",
      state: {},
    });
    await entities.upsert({
      entityId: "unverified-guest",
      type: "person",
      preferredName: "Unverified Guest",
      identities: [
        {
          platform: "email",
          handle: "unverified@example.test",
          verified: false,
          confidence: 0.5,
          addedAt: "2026-01-01T00:00:00.000Z",
          addedVia: "user_chat",
          evidence: ["Unverified address supplied in chat."],
        },
      ],
      tags: [],
      visibility: "owner_only",
      state: {},
    });

    household = getHouseholdCoordinationService(
      runtime,
    ) as HouseholdCoordinationService;
    await household.bindRole({
      entityId: "child-one",
      role: "child",
      subjectEntityIds: [],
      evidence: "Owner identified the child for agreement access boundaries.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      evidence: "Owner verified the co-parent relationship.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: "unverified-guest",
      role: "caregiver",
      subjectEntityIds: ["child-one"],
      evidence:
        "Owner recorded a caregiver relationship without identity verification.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const householdGrant = await household.issueGrant({
      principalEntityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    guestHouseholdGrantId = householdGrant.id;
  });

  afterAll(async () => {
    await runtimeResult?.cleanup();
    delete process.env.ELIZA_STATE_DIR;
    fs.rmSync(mediaStateDir, { recursive: true, force: true });
  });

  it("stores immutable content-addressed versions and rejects duplicate bytes", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const firstBytes = pdf("agreement version one");
    artifact = await service.createAgreementVersion({
      agreementKey: "parenting-plan",
      title: "Parenting plan",
      originalFilename: "parenting-plan.pdf",
      mimeType: "application/pdf",
      bytes: firstBytes,
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    expect(artifact).toMatchObject({
      version: 1,
      supersedesArtifactId: null,
      contentSha256: crypto
        .createHash("sha256")
        .update(firstBytes)
        .digest("hex"),
      mimeType: "application/pdf",
      byteSize: firstBytes.byteLength,
      pageCount: 12,
    });
    expect(artifact.mediaUrl).toBe(
      `/api/lifeops/agreements/${artifact.id}/download`,
    );
    await expect(
      runtime.getMemoryById(artifact.documentId as UUID),
    ).resolves.toMatchObject({
      metadata: {
        scope: "owner-private",
        pinned: false,
        mediaUrl: artifact.mediaUrl,
        mediaHash: artifact.contentSha256,
      },
    });

    await expect(
      service.createAgreementVersion({
        agreementKey: "parenting-plan",
        title: "Duplicate",
        originalFilename: "duplicate.pdf",
        mimeType: "application/pdf",
        bytes: firstBytes,
        uploadedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_DUPLICATE_CONTENT" });

    const second = await service.createAgreementVersion({
      agreementKey: "parenting-plan",
      title: "Parenting plan amended",
      originalFilename: "parenting-plan-amended.pdf",
      mimeType: "application/pdf",
      bytes: pdf("agreement version two"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    expect(second).toMatchObject({
      version: 2,
      supersedesArtifactId: artifact.id,
    });
    await expect(
      service.createAgreementVersion({
        agreementKey: "parenting-plan",
        title: "Old content replay",
        originalFilename: "old-content.pdf",
        mimeType: "application/pdf",
        bytes: firstBytes,
        uploadedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_DUPLICATE_CONTENT" });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({
      artifact: { version: 1, title: "Parenting plan" },
    });
  });

  it("requires valid page citations and makes review decisions terminal", async () => {
    const service = createAgreementKnowledgeService(runtime);
    await expect(
      service.proposeObligation({
        artifactId: artifact.id,
        title: "Invalid citation",
        obligationText: "This must never persist.",
        pageStart: 12,
        pageEnd: 13,
        citationText: "Outside the source page range.",
        proposedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });

    const approved = await service.proposeObligation({
      artifactId: artifact.id,
      title: "School notice",
      obligationText: "Share school notices within twenty-four hours.",
      pageStart: 4,
      pageEnd: 5,
      citationText: "Each parent shall forward school notices within 24 hours.",
      proposedByEntityId: runtime.agentId,
    });
    expect(approved).toMatchObject({
      status: "proposed",
      pageStart: 4,
      pageEnd: 5,
      proposedByEntityId: runtime.agentId,
    });
    const decided = await service.decideObligation({
      obligationId: approved.id,
      decision: "approve",
      decidedByEntityId: SELF_ENTITY_ID,
      reason: "Owner checked the cited pages against the signed PDF.",
    });
    expect(decided).toMatchObject({
      status: "approved",
      decidedByEntityId: SELF_ENTITY_ID,
      citationText: approved.citationText,
    });
    await expect(
      service.decideObligation({
        obligationId: approved.id,
        decision: "reject",
        decidedByEntityId: SELF_ENTITY_ID,
        reason: "Attempted reversal.",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_OBLIGATION_CONFLICT" });

    const rejected = await service.proposeObligation({
      artifactId: artifact.id,
      title: "Unsupported interpretation",
      obligationText: "An unsupported model interpretation.",
      pageStart: 8,
      citationText: "Source text retained for the rejection record.",
      proposedByEntityId: SELF_ENTITY_ID,
    });
    await service.decideObligation({
      obligationId: rejected.id,
      decision: "reject",
      decidedByEntityId: SELF_ENTITY_ID,
      reason: "The source does not support this interpretation.",
    });
  });

  it("keeps agent and chat pins separate from guest authorization", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const agentPin = await service.pin({
      artifactId: artifact.id,
      targetType: "agent",
      targetId: runtime.agentId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId: familyRoomId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });

    await service.unpin({
      pinId: agentPin.id,
      unpinnedByEntityId: SELF_ENTITY_ID,
    });

    const pinned = await service.activePinnedContext({
      ownerEntityId: SELF_ENTITY_ID,
      roomId: familyRoomId,
    });
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.obligations).toHaveLength(1);
    expect(pinned[0]?.obligations[0]?.status).toBe("approved");
    await expect(
      service.activePinnedContext({
        ownerEntityId: SELF_ENTITY_ID,
        roomId: "different-chat",
      }),
    ).resolves.toEqual([]);

    const ownerList = await service.listOwnerAgreements({
      ownerEntityId: SELF_ENTITY_ID,
    });
    expect(ownerList.map((view) => view.artifact.version)).toEqual([2, 1]);
    await expect(
      service.listOwnerAgreements({ ownerEntityId: "verified-co-parent" }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("composes approved pins on ordinary owner turns while preserving room and audience boundaries", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    const otherRoomId = crypto.randomUUID() as UUID;
    const previousOwner = runtime.getSetting("ELIZA_ADMIN_ENTITY_ID");
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
    await runtime.createEntity({
      id: ownerId,
      names: ["Pin owner"],
      agentId: runtime.agentId,
    });
    for (const id of [roomId, otherRoomId]) {
      await runtime.createRoom({
        id,
        source: "eliza-client",
        type: ChannelType.DM,
        worldId: runtime.agentId,
      });
      await runtime.addParticipant(ownerId, id);
      await runtime.addParticipant(runtime.agentId, id);
    }
    const compose = async (targetRoomId: UUID) => {
      const message: Memory = {
        id: crypto.randomUUID() as UUID,
        entityId: ownerId,
        agentId: runtime.agentId,
        roomId: targetRoomId,
        content: {
          text: "What approved agreement obligation applies here?",
          source: "eliza-client",
        },
      };
      await attestAuthenticatedApiDeliveryAudience(runtime, message, {
        kind: "owner_session",
        principalId: ownerId,
      });
      return composeResponseState(runtime, message);
    };
    let pin = await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId: roomId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    try {
      const state = await compose(roomId);
      expect(state.text).toContain(
        "Share school notices within twenty-four hours.",
      );
      expect(state.text).toContain("source pages 4-5");
      expect(state.text).not.toContain("An unsupported model interpretation.");
      expect((await compose(otherRoomId)).text).not.toContain(
        "Share school notices within twenty-four hours.",
      );

      await service.unpin({
        pinId: pin.id,
        unpinnedByEntityId: SELF_ENTITY_ID,
      });
      expect((await compose(roomId)).text).not.toContain(
        "Share school notices within twenty-four hours.",
      );
      pin = await service.pin({
        artifactId: artifact.id,
        targetType: "agent",
        targetId: runtime.agentId,
        pinnedByEntityId: SELF_ENTITY_ID,
      });
      expect((await compose(otherRoomId)).text).toContain(
        "Share school notices within twenty-four hours.",
      );

      const guestId = crypto.randomUUID() as UUID;
      await runtime.createEntity({
        id: guestId,
        names: ["Other participant"],
        agentId: runtime.agentId,
      });
      await runtime.addParticipant(guestId, roomId);
      expect((await compose(roomId)).text).not.toContain(
        "Share school notices within twenty-four hours.",
      );
    } finally {
      await service.unpin({
        pinId: pin.id,
        unpinnedByEntityId: SELF_ENTITY_ID,
      });
      runtime.setSetting(
        "ELIZA_ADMIN_ENTITY_ID",
        typeof previousOwner === "string" || typeof previousOwner === "boolean"
          ? previousOwner
          : null,
      );
    }
  });

  it("persists pin provenance atomically and rolls back when the audit ledger rejects it", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const targetId = crypto.randomUUID() as UUID;
    await createPinRoom(targetId);
    const pin = await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    const events = await executeRawSql(
      runtime,
      `SELECT inputs_json, decision_json FROM app_lifeops.life_audit_events
       WHERE agent_id = ${sqlQuote(runtime.agentId)}
         AND owner_type = 'parenting_agreement'
         AND owner_id = ${sqlQuote(artifact.id)}
         AND event_type = 'agreement_pinned'
         AND decision_json::jsonb->>'id' = ${sqlQuote(pin.id)}`,
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].inputs_json))).toMatchObject({
      actorEntityId: SELF_ENTITY_ID,
      source: {
        id: artifact.id,
        version: artifact.version,
        content_sha256: artifact.contentSha256,
      },
    });
    expect(JSON.parse(String(events[0].decision_json))).toMatchObject({
      id: pin.id,
      target_id: targetId,
      unpinned_at: null,
    });
    await service.unpin({ pinId: pin.id, unpinnedByEntityId: SELF_ENTITY_ID });
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_lifeops.reject_agreement_audit_test()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'audit persistence unavailable';
      END $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_agreement_audit_test
      BEFORE INSERT ON app_lifeops.life_audit_events FOR EACH ROW
      WHEN (NEW.event_type = 'agreement_pinned')
      EXECUTE FUNCTION app_lifeops.reject_agreement_audit_test()`,
    );
    const rejectedTarget = crypto.randomUUID() as UUID;
    await createPinRoom(rejectedTarget);
    try {
      await expect(
        service.pin({
          artifactId: artifact.id,
          targetType: "chat",
          targetId: rejectedTarget,
          pinnedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toThrow();
      const pins = await service.listPins({
        artifactId: artifact.id,
        ownerEntityId: SELF_ENTITY_ID,
      });
      expect(pins.some((item) => item.targetId === rejectedTarget)).toBe(false);
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_agreement_audit_test ON app_lifeops.life_audit_events",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_agreement_audit_test()",
      );
    }
  });

  it("exports the owner workspace with real packet records and verified nested source archives while denying guests", async () => {
    const packets = new MonthlyFamilyPacketService(runtime);
    const packet = await packets.buildInternal(
      {
        key: "2026-11",
        startsOn: "2026-11-01",
        endsOnExclusive: "2026-12-01",
        timeZone: "UTC",
      },
      [
        {
          claimId: "workspace-export-question",
          stableKey: "workspace-export-question",
          section: "unanswered",
          statement: "Confirm the synthetic library pickup date.",
          visibility: "owner_only",
          provenance: [
            {
              source: "knowledge",
              sourceId: artifact.id,
              observedAt: artifact.createdAt,
              contentSha256: artifact.contentSha256,
            },
          ],
          dates: [],
          requests: ["Confirm the pickup date"],
          urgency: null,
          commitments: [],
          accountability: [],
          unanswered: true,
        },
      ],
    );
    await expect(
      exportFamilyWorkspace(runtime, "unverified-guest"),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
    const exported = await exportFamilyWorkspace(runtime, SELF_ENTITY_ID);
    const files = readStoredZip(exported.bytes);
    const manifestBytes = files.get("manifest.json");
    const sums = files.get("SHA256SUMS");
    if (!manifestBytes || !sums)
      throw new Error("Workspace archive is incomplete");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const packetRow = manifest.records.packets.find(
      (row: { packet_id: string }) => row.packet_id === packet.packetId,
    );
    expect(JSON.parse(packetRow.packet_json)).toEqual(packet);
    const source = manifest.sourceArchives.find(
      (row: { artifactId: string }) => row.artifactId === artifact.id,
    );
    const nested = files.get(source.path);
    if (!nested) throw new Error("Workspace source archive is missing");
    expect(crypto.createHash("sha256").update(nested).digest("hex")).toBe(
      source.archiveSha256,
    );
    const original = readStoredZip(nested).get("original.pdf");
    if (!original) throw new Error("Original source bytes are missing");
    expect(crypto.createHash("sha256").update(original).digest("hex")).toBe(
      artifact.contentSha256,
    );
    for (const line of sums.toString("utf8").trim().split("\n")) {
      const [digest, name] = line.split("  ");
      const bytes = files.get(name);
      if (!bytes) throw new Error("Checksummed workspace member is missing");
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(
        digest,
      );
    }
    const audit = await executeRawSql(
      runtime,
      `SELECT decision_json FROM app_lifeops.life_audit_events WHERE agent_id=${sqlQuote(runtime.agentId)} AND id=${sqlQuote(manifest.exportId)}`,
    );
    expect(JSON.parse(String(audit[0].decision_json))).toEqual({
      manifestSha256: crypto
        .createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      archiveSha256: crypto
        .createHash("sha256")
        .update(exported.bytes)
        .digest("hex"),
    });
  });

  it("exports selected correspondence and its review history, excluding other tenants and rejecting changed or deleted originals", async () => {
    const documents = runtime.getService<DocumentService>(
      DocumentService.serviceType,
    );
    if (!documents) throw new Error("Canonical documents are unavailable");
    const text =
      "Synthetic correspondence: Please confirm the library pickup.\nNo agreement has been reached.";
    const selected = await importFamilyCorrespondence(runtime, {
      id: crypto.randomUUID(),
      periodKey: "2026-12",
      title: "Synthetic export source",
      text,
    });
    const foreignId = crypto.randomUUID();
    const store = new FamilyIntakeReviewStore(runtime);
    const access = {
      requesterEntityId: selected.selectedByEntityId,
      role: "OWNER" as const,
      isOwner: true,
    };
    try {
      const fact = {
        id: crypto.randomUUID(),
        section: "unanswered" as const,
        statement: "Library pickup remains unconfirmed.",
        sourceQuote: "Please confirm the library pickup.",
        dates: [],
        requests: ["Confirm pickup"],
        commitments: [],
        accountability: [],
        urgency: null,
        unanswered: true,
        recipientEntityIds: [],
      };
      const proposed = await store.propose({
        id: selected.id,
        expectedRevision: selected.revision,
        sourceSha256: selected.source.contentSha256,
        facts: [fact],
      });
      const reviewed = await store.review({
        id: selected.id,
        expectedRevision: proposed.revision,
        reviewerEntityId: selected.selectedByEntityId,
        facts: [
          {
            ...fact,
            statement: "Owner reviewed: pickup is still unconfirmed.",
          },
        ],
      });
      await executeRawSql(
        runtime,
        `INSERT INTO app_lifeops.life_family_intake_reviews
        (agent_id,id,period_key,document_id,revision,status,review_json)
        SELECT ${sqlQuote(crypto.randomUUID())},${sqlQuote(foreignId)},period_key,document_id,revision,status,review_json
        FROM app_lifeops.life_family_intake_reviews
        WHERE agent_id=${sqlQuote(runtime.agentId)} AND id=${sqlQuote(selected.id)}`,
      );
      const files = readStoredZip(
        (await exportFamilyWorkspace(runtime, SELF_ENTITY_ID)).bytes,
      );
      const manifestBytes = files.get("manifest.json");
      if (!manifestBytes) throw new Error("Workspace manifest is missing");
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      expect(manifest.records.intakeReviews).toEqual(
        expect.arrayContaining(
          [selected, proposed, reviewed].map((review) =>
            expect.objectContaining({
              id: selected.id,
              revision: review.revision,
              review_json: review,
            }),
          ),
        ),
      );
      expect(
        manifest.records.intakeReviews.some(
          (row: { id: string }) => row.id === foreignId,
        ),
      ).toBe(false);
      const sources = manifest.intakeSources.filter(
        (source: { documentId: string }) =>
          source.documentId === selected.source.documentId,
      );
      expect(sources).toHaveLength(1);
      const original = files.get(sources[0].path);
      if (!original) throw new Error("Selected correspondence is missing");
      expect(original.toString("utf8")).toBe(text);
      expect(crypto.createHash("sha256").update(original).digest("hex")).toBe(
        selected.source.contentSha256,
      );
      await documents.updateDocument({
        documentId: selected.source.documentId as UUID,
        content: "Changed correspondence",
        accessContext: access,
      });
      await expect(
        exportFamilyWorkspace(runtime, SELF_ENTITY_ID),
      ).rejects.toMatchObject({ code: "FAMILY_EXPORT_SOURCE_INTEGRITY" });
      await documents.deleteDocumentWithAccessContext(
        selected.source.documentId as UUID,
        access,
      );
      await expect(
        exportFamilyWorkspace(runtime, SELF_ENTITY_ID),
      ).rejects.toMatchObject({ code: "FAMILY_EXPORT_SOURCE_UNAVAILABLE" });
    } finally {
      await executeRawSql(
        runtime,
        `DELETE FROM app_lifeops.life_family_intake_reviews WHERE id IN (${sqlQuote(selected.id)},${sqlQuote(foreignId)})`,
      );
    }
  });

  it("exports retained school bytes without executor leases or another agent's records and fails on missing source bytes", async () => {
    await new SchoolCalendarWorkflow(runtime).ensureSchema();
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Canonical file storage is unavailable");
    const bytes = pdf(
      "Synthetic retained school calendar for workspace export",
    );
    const stored = await storage.store(bytes, "application/pdf");
    const runId = crypto.randomUUID();
    const foreignId = crypto.randomUUID();
    const at = new Date().toISOString();
    for (const [agentId, sourceId] of [
      [runtime.agentId, "workspace-school"],
      [foreignId, "other-agent-private-school"],
    ]) {
      await executeRawSql(
        runtime,
        `INSERT INTO app_lifeops.life_school_calendar_runs (agent_id,run_id,source_id,state,trigger_kind,content_sha256,media_url,apply_lease_token,created_at,updated_at) VALUES (${sqlQuote(agentId)},${sqlQuote(runId)},${sqlQuote(sourceId)},'unchanged','manual',${sqlQuote(stored.hash)},${sqlQuote(stored.url)},'internal-executor-lease-canary',${sqlQuote(at)},${sqlQuote(at)})`,
      );
    }
    await new SchoolCalendarWorkflow(runtime).retainRecordedSources();
    await new SchoolCalendarWorkflow(runtime).retainRecordedSources();
    const references = (await runtime.getAllMemories()).filter(
      (memory) => memory.metadata?.mediaUrl === stored.url,
    );
    expect(references).toHaveLength(1);
    const orphan = await storage.store(
      pdf("Unreferenced source control"),
      "application/pdf",
    );
    const stateDirectory = process.env.ELIZA_STATE_DIR;
    if (!stateDirectory) throw new Error("Test state directory is unavailable");
    const sourcePath = path.join(stateDirectory, "media", stored.fileName);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(sourcePath, old, old);
    fs.utimesSync(
      path.join(stateDirectory, "media", orphan.fileName),
      old,
      old,
    );
    try {
      gcUnreferencedMedia(
        collectReferencedMedia(await runtime.getAllMemories(), runtime),
      );
      expect(await storage.read(stored.fileName)).toEqual(bytes);
      expect(await storage.read(orphan.fileName)).toBeNull();
    } finally {
      // Restore the fixture even when the retention regression fails, so later
      // export tests do not inherit a missing source from this diagnostic.
      await storage.store(bytes, "application/pdf");
    }
    const exported = readStoredZip(
      (await exportFamilyWorkspace(runtime, SELF_ENTITY_ID)).bytes,
    );
    expect(exported.get(`school/${stored.hash}.pdf`)).toEqual(bytes);
    const manifest = exported.get("manifest.json");
    if (!manifest) throw new Error("Workspace manifest is missing");
    expect(manifest.toString("utf8")).not.toContain(
      "internal-executor-lease-canary",
    );
    expect(manifest.toString("utf8")).not.toContain(
      "other-agent-private-school",
    );
    const auditCount = async () =>
      executeRawSql(
        runtime,
        `SELECT count(*)::integer AS count FROM app_lifeops.life_audit_events WHERE agent_id=${sqlQuote(runtime.agentId)} AND event_type='family_workspace_export_prepared'`,
      );
    const before = await auditCount();
    try {
      await storage.delete(stored.url.replace("/api/media/", ""));
      await expect(
        new SchoolCalendarWorkflow(runtime).retainRecordedSources(),
      ).rejects.toMatchObject({ code: "SCHOOL_CALENDAR_SOURCE_INTEGRITY" });
      await expect(
        exportFamilyWorkspace(runtime, SELF_ENTITY_ID),
      ).rejects.toMatchObject({ code: "FAMILY_EXPORT_SOURCE_INTEGRITY" });
      expect(await auditCount()).toEqual(before);
    } finally {
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_school_calendar_runs SET apply_lease_token = NULL WHERE run_id = ${sqlQuote(runId)}`,
      );
      await storage.store(bytes, "application/pdf");
    }
  });

  it("retains a newly retrieved school PDF through the real source workflow and garbage collector", async () => {
    const bytes = pdf("Newly retrieved synthetic school calendar");
    const workflow = new SchoolCalendarWorkflow(runtime, {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedFetchImpl: async ({ url }) =>
        url.pathname.endsWith(".pdf")
          ? new Response(new Uint8Array(bytes), {
              headers: { "content-type": "application/pdf" },
            })
          : new Response(
              '<a href="https://resources.finalsite.net/CPSCCRSD2026-2027SchoolCalendar.pdf">Calendar</a>',
              {
                headers: { "content-type": "text/html" },
              },
            ),
      extractPdfText: async () => "2026-09-01 | First day of school",
    });
    const result = await workflow.run({
      ...CONCORD_SCHOOL_CALENDAR_SOURCE,
      sourceId: "new-source-retention",
    });
    if (result.state !== "awaiting_approval")
      throw new Error("Expected a source plan");
    const stateDirectory = process.env.ELIZA_STATE_DIR;
    if (!stateDirectory) throw new Error("Test state directory is unavailable");
    const fileName = `${result.plan.contentSha256}.pdf`;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(stateDirectory, "media", fileName), old, old);
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Canonical file storage is unavailable");
    try {
      gcUnreferencedMedia(
        collectReferencedMedia(await runtime.getAllMemories(), runtime),
      );
      const exported = readStoredZip(
        (await exportFamilyWorkspace(runtime, SELF_ENTITY_ID)).bytes,
      );
      expect(exported.get(`school/${fileName}`)).toEqual(bytes);
      expect(
        (await workflow.status("new-source-retention")).lastRun?.state,
      ).toBe("awaiting_approval");
    } finally {
      await storage.store(bytes, "application/pdf");
    }
  });

  it("preserves packet-bound stored delivery receipts without including unrelated approval payloads", async () => {
    const packet = await new MonthlyFamilyPacketService(runtime).latest(
      "2026-11",
    );
    if (!packet) throw new Error("Workspace test packet is unavailable");
    const approvalId = crypto.randomUUID();
    const unrelatedId = crypto.randomUUID();
    const body = "Synthetic packet delivery record for export verification.";
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const at = new Date().toISOString();
    // Historical provider evidence is a database fixture; this test sends no message.
    const receipt = {
      provider: "fixture-provider",
      messageId: "stored-message-receipt",
      acceptedAt: at,
    };
    for (const [id, content] of [
      [approvalId, body],
      [unrelatedId, "unrelated-approval-body-canary"],
    ]) {
      await executeRawSql(
        runtime,
        `INSERT INTO approval_requests (id,agent_id,state,requested_by,subject_user_id,action,payload,channel,reason,expires_at,provider_receipt) VALUES (${sqlQuote(id)},${sqlQuote(runtime.agentId)},'executed','self','self','send_message',${sqlQuote(JSON.stringify({ action: "send_message", recipient: "+15555550101", body: content }))}::jsonb,'imessage','Synthetic historical fixture','2099-01-01T00:00:00Z',${sqlQuote(JSON.stringify(receipt))}::jsonb)`,
      );
    }
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_family_packet_drafts (agent_id,packet_id,internal_version,draft_version,recipient,body,body_sha256,transformations_json,created_at) VALUES (${sqlQuote(runtime.agentId)},${sqlQuote(packet.packetId)},${packet.version},1,'+15555550101',${sqlQuote(body)},${sqlQuote(bodyHash)},'[]',${sqlQuote(at)})`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_family_packet_approvals (agent_id,packet_id,draft_version,draft_sha256,approval_id,created_at) VALUES (${sqlQuote(runtime.agentId)},${sqlQuote(packet.packetId)},1,${sqlQuote(bodyHash)},${sqlQuote(approvalId)},${sqlQuote(at)})`,
    );
    const manifestBytes = readStoredZip(
      (await exportFamilyWorkspace(runtime, SELF_ENTITY_ID)).bytes,
    ).get("manifest.json");
    if (!manifestBytes) throw new Error("Workspace manifest is unavailable");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.records.approvals).toEqual([
      expect.objectContaining({
        id: approvalId,
        state: "executed",
        provider_receipt: receipt,
      }),
    ]);
    expect(manifest.records.drafts).toEqual([
      expect.objectContaining({
        packet_id: packet.packetId,
        body,
        body_sha256: bodyHash,
      }),
    ]);
    expect(manifestBytes.toString("utf8")).not.toContain(
      "unrelated-approval-body-canary",
    );
  });

  it("exports verified originals and complete persisted provenance without granting guest export access", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const original = await service.readOwnerPdf({
      artifactId: artifact.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const exported = await service.exportOwnerAgreement({
      artifactId: artifact.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const files = readStoredZip(exported.bytes);
    expect(files.get("original.pdf")).toEqual(original.bytes);
    const manifestBytes = files.get("manifest.json");
    if (!manifestBytes) throw new Error("Export manifest missing");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.artifact).toEqual(artifact);
    const agreement = (
      await service.listOwnerAgreements({ ownerEntityId: SELF_ENTITY_ID })
    ).find((item) => item.artifact.id === artifact.id);
    if (!agreement) throw new Error("Source agreement missing");
    expect(manifest.obligations).toEqual(
      expect.arrayContaining(agreement.obligations),
    );
    const extractionBytes = files.get("extraction.json");
    if (!extractionBytes) throw new Error("Saved extraction missing");
    const extraction = JSON.parse(extractionBytes.toString("utf8"));
    const ingestion = manifest.audit.find(
      (event: { event_type: string }) =>
        event.event_type === "agreement_ingested",
    );
    if (!ingestion) throw new Error("Ingestion audit missing");
    expect(
      crypto.createHash("sha256").update(extractionBytes).digest("hex"),
    ).toBe(JSON.parse(ingestion.inputs_json).extractionSha256);
    expect(
      extraction.pages.every(
        (page: { text: string }) =>
          page.text === original.bytes.toString("utf8"),
      ),
    ).toBe(true);
    expect(
      manifest.pins.some(
        (pin: { unpinnedAt: string | null }) => pin.unpinnedAt !== null,
      ),
    ).toBe(true);
    const sums = files.get("SHA256SUMS")?.toString("utf8");
    for (const name of ["original.pdf", "manifest.json", "extraction.json"]) {
      const file = files.get(name);
      if (!file) throw new Error(`Missing exported ${name}`);
      expect(sums).toContain(
        `${crypto.createHash("sha256").update(file).digest("hex")}  ${name}\n`,
      );
    }
    const events = await executeRawSql(
      runtime,
      `SELECT decision_json FROM app_lifeops.life_audit_events WHERE agent_id = ${sqlQuote(runtime.agentId)} AND id = ${sqlQuote(manifest.exportId)}`,
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].decision_json))).toEqual({
      manifestSha256: crypto
        .createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      archiveSha256: crypto
        .createHash("sha256")
        .update(exported.bytes)
        .digest("hex"),
    });
    await expect(
      service.exportOwnerAgreement({
        artifactId: artifact.id,
        ownerEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("refuses missing or corrupted originals without recording a prepared export", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const file = path.join(mediaStateDir, "media", artifact.mediaFileName);
    const original = fs.readFileSync(file);
    const countExports = () =>
      executeRawSql(
        runtime,
        `SELECT id FROM app_lifeops.life_audit_events WHERE agent_id = ${sqlQuote(runtime.agentId)} AND owner_id = ${sqlQuote(artifact.id)} AND event_type = 'agreement_export_prepared' ORDER BY id`,
      );
    const before = await countExports();
    try {
      fs.writeFileSync(file, Buffer.alloc(original.length, 0));
      await expect(
        service.exportOwnerAgreement({
          artifactId: artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
      fs.unlinkSync(file);
      await expect(
        service.exportOwnerAgreement({
          artifactId: artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_STORAGE_UNAVAILABLE" });
      expect(await countExports()).toEqual(before);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it("detects altered extraction metadata and identifies legacy history explicitly", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const source = await service.createAgreementVersion({
      agreementKey: "export-provenance-test",
      title: "Export provenance",
      originalFilename: "provenance.pdf",
      mimeType: "application/pdf",
      bytes: pdf("export provenance"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    await executeRawSql(
      runtime,
      `UPDATE memories SET metadata = metadata - 'agreementExtractionJson' WHERE id = ${sqlQuote(source.documentId)} AND agent_id = ${sqlQuote(runtime.agentId)}`,
    );
    await expect(
      service.exportOwnerAgreement({
        artifactId: source.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
    // Simulate the actual legacy schema state: no extraction map and no ingestion event.
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_audit_events WHERE agent_id = ${sqlQuote(runtime.agentId)} AND owner_id = ${sqlQuote(source.id)} AND event_type = 'agreement_ingested'`,
    );
    const exported = await service.exportOwnerAgreement({
      artifactId: source.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const bytes = readStoredZip(exported.bytes).get("manifest.json");
    if (!bytes) throw new Error("Export manifest missing");
    const manifest = JSON.parse(bytes.toString("utf8"));
    expect(manifest.extraction).toMatchObject({ status: "unavailable" });
    expect(manifest.auditCoverage.status).toBe("partial_legacy_history");
    expect(manifest.audit).toEqual([]);
    expect(manifest.obligations).toEqual([]);
  });

  it("keeps concurrent pin transitions and their audit evidence in the same export snapshot", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const repository = new AgreementKnowledgeRepository(
      runtime,
      runtime.agentId,
    );
    const targetId = crypto.randomUUID() as UUID;
    await createPinRoom(targetId);
    const mutate = async () => {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const pin = await service.pin({
          artifactId: artifact.id,
          targetType: "chat",
          targetId,
          pinnedByEntityId: SELF_ENTITY_ID,
        });
        await service.unpin({
          pinId: pin.id,
          unpinnedByEntityId: SELF_ENTITY_ID,
        });
      }
    };
    const observe = async () => {
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const snapshot = await repository.readExportSnapshot(artifact.id);
        const pin = snapshot.pins.find((item) => item.targetId === targetId);
        if (!pin) continue;
        const transitions = snapshot.audit
          .filter(
            (event) =>
              event.event_type ===
              (pin.unpinnedAt ? "agreement_unpinned" : "agreement_pinned"),
          )
          .map((event) => JSON.parse(String(event.decision_json)));
        expect(transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: pin.id,
              pinned_at: pin.pinnedAt,
              unpinned_at: pin.unpinnedAt,
            }),
          ]),
        );
      }
    };
    await Promise.all([mutate(), observe()]);
    const final = await repository.readExportSnapshot(artifact.id);
    expect(
      final.pins.find((item) => item.targetId === targetId)?.unpinnedAt,
    ).toBeTruthy();
  });

  it("requires verified identity plus an exact active household grant", async () => {
    const service = createAgreementKnowledgeService(runtime);
    await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId: familyRoomId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      service.activePinnedContextForPrincipal({
        principalEntityId: "verified-co-parent",
        roomId: familyRoomId,
      }),
    ).resolves.toEqual([]);
    const unverifiedGrant = await household.issueGrant({
      principalEntityId: "unverified-guest",
      role: "caregiver",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await expect(
      service.grantGuestRead({
        artifactId: artifact.id,
        principalEntityId: "unverified-guest",
        householdGrantId: unverifiedGrant.id,
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });

    await expect(
      service.previewGuestRead({
        artifactId: artifact.id,
        principalEntityId: "unverified-guest",
        householdGrantId: unverifiedGrant.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      denial: { code: "AGREEMENT_ACCESS_DENIED" },
      exclusions: expect.arrayContaining(["inherit_access_from_pin"]),
    });

    await expect(
      service.previewGuestRead({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
        householdGrantId: guestHouseholdGrantId,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      denial: null,
      effects: ["read_artifact_metadata", "read_approved_obligations"],
    });

    const resourceGrant = await service.grantGuestRead({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
      householdGrantId: guestHouseholdGrantId,
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const guestView = await service.readFor({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
    });
    expect(guestView.obligations).toHaveLength(1);
    expect(guestView.obligations[0]).toMatchObject({
      status: "approved",
      pageStart: 4,
      pageEnd: 5,
    });
    for (const forbidden of [
      "mediaUrl",
      "mediaFileName",
      "contentSha256",
      "documentId",
      "agentId",
      "uploadedByEntityId",
      "householdId",
      "agreementKey",
      "supersedesArtifactId",
    ]) {
      expect(guestView.artifact).not.toHaveProperty(forbidden);
    }
    for (const forbidden of [
      "agentId",
      "artifactId",
      "proposedByEntityId",
      "decidedByEntityId",
      "decisionReason",
      "createdAt",
      "updatedAt",
    ]) {
      expect(guestView.obligations[0]).not.toHaveProperty(forbidden);
    }
    const guestPinned = await service.activePinnedContextForPrincipal({
      principalEntityId: "verified-co-parent",
      roomId: familyRoomId,
    });
    expect(guestPinned).toEqual([guestView]);

    const restartedService = createAgreementKnowledgeService(runtime);
    await expect(
      restartedService.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).resolves.toMatchObject({ artifact: { id: artifact.id, version: 1 } });

    const revoked = await service.revokeGuestRead({
      grantId: resourceGrant.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Owner removed access.",
    });
    await expect(
      restartedService.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
    await expect(
      restartedService.activePinnedContextForPrincipal({
        principalEntityId: "verified-co-parent",
        roomId: familyRoomId,
      }),
    ).resolves.toEqual([]);
    const exported = await restartedService.exportOwnerAgreement({
      artifactId: artifact.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const manifestBytes = readStoredZip(exported.bytes).get("manifest.json");
    if (!manifestBytes) throw new Error("Export manifest missing");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.grants).toContainEqual(revoked);
    expect(manifest.householdGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: guestHouseholdGrantId }),
      ]),
    );
    expect(manifest.householdGrantAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner_id: guestHouseholdGrantId }),
      ]),
    );
    expect(manifest.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "agreement_granted" }),
        expect.objectContaining({ event_type: "agreement_revoked" }),
      ]),
    );
  });

  it("fails closed after household-grant revocation or expiry", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const expiring = await household.issueGrant({
      principalEntityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-06-01T00:00:00.000Z",
    });
    await service.grantGuestRead({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
      householdGrantId: expiring.id,
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
        at: new Date("2100-01-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });

    await household.revokeGrant({
      grantId: expiring.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Relationship access was revoked.",
    });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("serves only the bound guest projection over HTTP and denies revoked access", async () => {
    const db = (
      runtime as AgentRuntime & {
        adapter: { db: ConstructorParameters<typeof AuthStore>[0] };
      }
    ).adapter.db;
    const auth = new AuthStore(db);
    const identityId = crypto.randomUUID();
    await auth.createIdentity({
      id: identityId,
      kind: "machine",
      displayName: "synthetic guest",
      createdAt: Date.now(),
      passwordHash: null,
      cloudUserId: null,
    });
    const { session } = await createMachineSession(auth, {
      identityId,
      scopes: [],
    });
    const ownerIdentityId = crypto.randomUUID();
    await auth.createIdentity({
      id: ownerIdentityId,
      kind: "owner",
      displayName: "synthetic export owner",
      createdAt: Date.now(),
      passwordHash: null,
      cloudUserId: null,
    });
    const { session: ownerSession } = await createBrowserSession(auth, {
      identityId: ownerIdentityId,
      ip: null,
      userAgent: null,
      rememberDevice: false,
    });
    const service = createAgreementKnowledgeService(runtime);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        url,
        pathname: url.pathname,
        method: req.method ?? "GET",
        runtime,
        isAuthorized: () => true,
      });
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}/api/lifeops/agreements/${artifact.id}`;
    // Model the public reverse proxy so loopback operator trust cannot mask guest auth.
    const headers = {
      Host: "guest-agreement.example.test",
      "x-forwarded-for": "203.0.113.20",
      Authorization: `Bearer ${session.id}`,
      "x-eliza-entity-id": "self",
    };
    try {
      const workspaceUrl = `http://127.0.0.1:${address.port}/api/lifeops/family-workflows/export`;
      expect(
        (await fetch(workspaceUrl, { method: "POST", headers })).status,
      ).toBe(403);
      const workspace = await fetch(workspaceUrl, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${ownerSession.id}` },
      });
      expect(workspace.status, await workspace.clone().text()).toBe(200);
      expect(workspace.headers.get("content-type")).toBe("application/zip");
      expect(workspace.headers.get("cache-control")).toContain("no-store");
      const workspaceFiles = readStoredZip(
        Buffer.from(await workspace.arrayBuffer()),
      );
      const workspaceManifest = workspaceFiles.get("manifest.json");
      if (!workspaceManifest)
        throw new Error("HTTP workspace archive is incomplete");
      expect(
        JSON.parse(workspaceManifest.toString("utf8")).sourceArchives,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: artifact.id,
            contentSha256: artifact.contentSha256,
          }),
        ]),
      );
      const unbound = await fetch(`${base}/shared?principalEntityId=self`, {
        headers,
      });
      expect(unbound.status, await unbound.text()).toBe(403);
      await bindMachineAuthIdentityToEntity({
        runtime,
        entityId: "verified-co-parent",
        authIdentityId: identityId,
      });
      expect((await fetch(`${base}/shared`, { headers })).status).toBe(403);
      const grant = await service.grantGuestRead({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
        householdGrantId: guestHouseholdGrantId,
        issuedByEntityId: SELF_ENTITY_ID,
      });
      const response = await fetch(`${base}/shared?principalEntityId=self`, {
        headers,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const payload = await response.json();
      expect(payload.agreement.obligations).toHaveLength(1);
      expect(payload.agreement.obligations[0]).toMatchObject({
        status: "approved",
        pageStart: 4,
        pageEnd: 5,
      });
      expect(payload.agreement.artifact).not.toHaveProperty("mediaUrl");
      expect(payload.agreement.obligations[0]).not.toHaveProperty(
        "decisionReason",
      );
      const ownerOptions = await fetch(`${base}/guest-options`);
      expect(ownerOptions.status, await ownerOptions.clone().text()).toBe(200);
      expect(ownerOptions.headers.get("cache-control")).toContain("no-store");
      expect((await ownerOptions.json()).grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grantId: grant.id,
            principalEntityId: "verified-co-parent",
            canRead: true,
          }),
        ]),
      );
      for (const [suffix, method] of [
        ["", "GET"],
        ["/download", "GET"],
        ["/export", "POST"],
        ["/guest-projection?principalEntityId=self", "GET"],
        ["/guest-options", "GET"],
      ]) {
        expect(
          (await fetch(`${base}${suffix}`, { method, headers })).status,
        ).toBe(403);
      }
      await service.revokeGuestRead({
        grantId: grant.id,
        revokedByEntityId: SELF_ENTITY_ID,
        reason: "Synthetic HTTP acceptance cleanup",
      });
      expect((await fetch(`${base}/shared`, { headers })).status).toBe(403);
      expect(await auth.revokeSession(session.id)).toBe(true);
      expect((await fetch(`${base}/shared`, { headers })).status).not.toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await auth.revokeSession(session.id);
      await auth.revokeSession(ownerSession.id);
    }
  });

  it("rejects non-owner mutations and malformed PDF input", async () => {
    const service = createAgreementKnowledgeService(runtime);
    await expect(
      service.createAgreementVersion({
        agreementKey: "guest-write",
        title: "Guest write",
        originalFilename: "guest.pdf",
        mimeType: "application/pdf",
        bytes: pdf("guest"),
        uploadedByEntityId: "verified-co-parent",
      }),
    ).rejects.toBeInstanceOf(AgreementKnowledgeError);
    await expect(
      service.createAgreementVersion({
        agreementKey: "not-pdf",
        title: "Not PDF",
        originalFilename: "not-pdf.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from("not actually a PDF"),
        uploadedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
  });
  it("keeps a transcription outage out of persisted agreements and retries the same bytes", async () => {
    const previous = runtime.services.get(ServiceType.PDF);
    if (!previous) throw new Error("PDF test service is unavailable");
    const transcription = new AgreementTestPdfService(runtime);
    const failure = new ElizaError("Transcription dependency failed", {
      code: "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE",
      context: { pageNumber: 2, pageCount: 2 },
      cause: new Error("upstream unavailable"),
    });
    transcription.transcriptionFailure = failure;
    runtime.services.set(ServiceType.PDF, [transcription]);
    try {
      const service = createAgreementKnowledgeService(runtime);
      const before = await service.listOwnerAgreements({
        ownerEntityId: SELF_ENTITY_ID,
      });
      const input = {
        agreementKey: "transcription-retry",
        title: "Synthetic retry agreement",
        originalFilename: "retry.pdf",
        mimeType: "application/pdf",
        bytes: pdf("distinct retry fixture"),
        uploadedByEntityId: SELF_ENTITY_ID,
      };
      await expect(service.createAgreementVersion(input)).rejects.toMatchObject(
        {
          code: "AGREEMENT_EXTRACTION_UNAVAILABLE",
          context: { pageNumber: 2, pageCount: 2 },
          cause: failure,
        },
      );
      expect(runtime.getRecentReportedErrors()).toContainEqual(
        expect.objectContaining({
          scope: "AgreementKnowledge.extractCompleteDocument",
          code: "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE",
          context: { pageNumber: 2, pageCount: 2 },
        }),
      );
      expect(
        await service.listOwnerAgreements({ ownerEntityId: SELF_ENTITY_ID }),
      ).toEqual(before);
      transcription.transcriptionFailure = null;
      const saved = await service.createAgreementVersion(input);
      expect(
        (
          await service.readOwnerPdf({
            artifactId: saved.id,
            ownerEntityId: SELF_ENTITY_ID,
          })
        ).bytes,
      ).toEqual(input.bytes);
      await expect(service.createAgreementVersion(input)).rejects.toMatchObject(
        { code: "AGREEMENT_DUPLICATE_CONTENT" },
      );
      expect(
        await service.listOwnerAgreements({ ownerEntityId: SELF_ENTITY_ID }),
      ).toHaveLength(before.length + 1);
    } finally {
      runtime.services.set(ServiceType.PDF, previous);
    }
  });
  it("lists only verified scoped permissions and retains unavailable bindings for owner revocation", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const source = await service.createAgreementVersion({
      agreementKey: "guest-choice-contract",
      title: "Guest choice contract",
      originalFilename: "guest-choices.pdf",
      mimeType: "application/pdf",
      bytes: pdf("guest choice filtering"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    const input = {
      principalEntityId: "verified-co-parent",
      role: "co_parent" as const,
      subjectEntityIds: ["child-one"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const active = await household.issueGrant({
      ...input,
      scopes: ["knowledge.read"],
    });
    const calendar = await household.issueGrant({
      ...input,
      scopes: ["calendar.freebusy"],
    });
    const expired = await household.issueGrant({
      ...input,
      scopes: ["knowledge.read"],
    });
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_household_access_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = ${sqlQuote(runtime.agentId)} AND id = ${sqlQuote(expired.id)}`,
    );
    const unverified = await household.issueGrant({
      ...input,
      principalEntityId: "unverified-guest",
      role: "caregiver",
      scopes: ["knowledge.read"],
    });
    const otherHousehold = `other-choices-${crypto.randomUUID()}`;
    await household.bindRole({
      householdId: otherHousehold,
      entityId: input.principalEntityId,
      role: input.role,
      subjectEntityIds: input.subjectEntityIds,
      evidence: "Separate synthetic household",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const other = await household.issueGrant({
      ...input,
      householdId: otherHousehold,
      scopes: ["knowledge.read"],
    });
    const options = await service.listGuestAccessOptions({
      artifactId: source.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    expect(options.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          householdGrantId: active.id,
          principalEntityId: input.principalEntityId,
          displayName: "Verified Co-parent",
        }),
      ]),
    );
    const ids = options.candidates.map((item) => item.householdGrantId);
    for (const excluded of [calendar, expired, unverified, other])
      expect(ids).not.toContain(excluded.id);
    const binding = await service.grantGuestRead({
      artifactId: source.id,
      principalEntityId: input.principalEntityId,
      householdGrantId: active.id,
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await household.revokeGrant({
      grantId: active.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Permission removed after selection",
    });
    const after = await service.listGuestAccessOptions({
      artifactId: source.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    expect(after.candidates.map((item) => item.householdGrantId)).not.toContain(
      active.id,
    );
    expect(after.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grantId: binding.id, canRead: false }),
      ]),
    );
    await expect(
      service.grantGuestRead({
        artifactId: source.id,
        principalEntityId: input.principalEntityId,
        householdGrantId: active.id,
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_GRANT_REVOKED" });
    await service.revokeGuestRead({
      grantId: binding.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Remove unavailable resource binding",
    });
    expect(
      (
        await service.listGuestAccessOptions({
          artifactId: source.id,
          ownerEntityId: SELF_ENTITY_ID,
        })
      ).grants,
    ).toEqual([]);
    await expect(
      service.listGuestAccessOptions({
        artifactId: source.id,
        ownerEntityId: input.principalEntityId,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("rejects a previously listed conversation after the agent leaves it", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const roomId = crypto.randomUUID() as UUID;
    await createPinRoom(roomId);
    expect(
      (await service.listPinTargets(SELF_ENTITY_ID)).chats.some(
        (chat) => chat.id === roomId,
      ),
    ).toBe(true);
    const source = await service.createAgreementVersion({
      agreementKey: "stale-pin-destination",
      title: "Stale pin destination",
      originalFilename: "stale-pin.pdf",
      mimeType: "application/pdf",
      bytes: pdf("stale pin destination"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    await runtime.removeParticipant(runtime.agentId, roomId);
    await expect(
      service.pin({
        artifactId: source.id,
        targetType: "chat",
        targetId: roomId,
        pinnedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
    await expect(
      service.listPins({
        artifactId: source.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toEqual([]);
  });

  it.each(["agent", "chat"] as const)(
    "rejects a nonexistent %s pin target without saving a phantom pin",
    async (targetType) => {
      const service = createAgreementKnowledgeService(runtime);
      const source = await service.createAgreementVersion({
        agreementKey: `pin-target-${targetType}`,
        title: "Pin target validation",
        originalFilename: "pin-target.pdf",
        mimeType: "application/pdf",
        bytes: pdf(`pin target validation ${targetType}`),
        uploadedByEntityId: SELF_ENTITY_ID,
      });
      await expect(
        service.pin({
          artifactId: source.id,
          targetType,
          targetId: crypto.randomUUID(),
          pinnedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
      await expect(
        service.listPins({
          artifactId: source.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).resolves.toEqual([]);
    },
  );
  it("validates owner corrections, commits concurrent retries once, and preserves a decision across restart", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const citation = "Share school notices within 24 hours.";
    const source = await service.createAgreementVersion({
      agreementKey: "owner-review-correction",
      title: "Owner correction",
      originalFilename: "owner-review.pdf",
      mimeType: "application/pdf",
      bytes: pdf(citation),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    const input = {
      artifactId: source.id,
      ownerEntityId: SELF_ENTITY_ID,
      proposal: {
        title: "School notices",
        obligationText: citation,
        citationText: citation,
        pageStart: 1,
        pageEnd: 1,
      },
    };
    await expect(
      service.addOwnerReviewProposal({
        ...input,
        ownerEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
    await expect(
      service.addOwnerReviewProposal({
        ...input,
        proposal: { ...input.proposal, citationText: "Silence is consent." },
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_REVIEW_CITATION_INVALID" });
    await expect(
      service.readFor({
        artifactId: source.id,
        principalEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({ obligations: [] });
    const second = createAgreementKnowledgeService(runtime);
    const receipts = await Promise.all([
      service.addOwnerReviewProposal(input),
      second.addOwnerReviewProposal(input),
    ]);
    expect(receipts.filter((receipt) => receipt.created)).toHaveLength(1);
    expect(receipts[0]?.obligation.id).toBe(receipts[1]?.obligation.id);
    const obligation = receipts[0]?.obligation;
    if (!obligation) throw new Error("Expected saved owner proposal");
    expect(obligation.status).toBe("proposed");
    await expect(
      service.listPins({
        artifactId: source.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toEqual([]);
    await service.decideObligation({
      obligationId: obligation.id,
      decision: "approve",
      decidedByEntityId: SELF_ENTITY_ID,
      reason: "Checked the original quote",
    });
    const restarted = createAgreementKnowledgeService(runtime);
    await expect(
      restarted.addOwnerReviewProposal(input),
    ).resolves.toMatchObject({
      created: false,
      obligation: {
        id: obligation.id,
        status: "approved",
        decisionReason: "Checked the original quote",
      },
    });
    const readback = await restarted.readFor({
      artifactId: source.id,
      principalEntityId: SELF_ENTITY_ID,
    });
    expect(readback.obligations).toHaveLength(1);
    expect(readback.obligations[0]?.status).toBe("approved");
    await expect(
      restarted.readOwnerReview({
        artifactId: source.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toBeNull();
  });

  it("prepares cited proposals once, preserves owner decisions across restart, and never activates them implicitly", async () => {
    runtime.setSetting("ELIZA_TRAJECTORY_LOGGING", "1");
    if (!runtime.getService("trajectories"))
      await runtime.registerService(TrajectoriesService);
    await runtime.getServiceLoadPromise("trajectories");
    const trajectories =
      runtime.getService<TrajectoriesService>("trajectories");
    if (!trajectories) throw new Error("Trajectory service unavailable");
    expect(trajectories.isEnabled()).toBe(true);
    const service = createAgreementKnowledgeService(runtime);
    const citation = "Each parent must share school notices within 24 hours.";
    const source = await service.createAgreementVersion({
      agreementKey: "review-generation-retry",
      title: "Review generation",
      originalFilename: "review.pdf",
      mimeType: "application/pdf",
      bytes: pdf(citation),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    let calls = 0;
    let modelPrompt = "";
    let modelOutput = "";
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async (_runtime, params) => {
        calls += 1;
        expect(typeof params.prompt).toBe("string");
        expect(params.prompt).toContain(citation);
        expect(params.prompt).toContain('"pageNumber":12');
        modelPrompt = String(params.prompt);
        modelOutput = JSON.stringify({
          complete: true,
          reviewedPages: Array.from({ length: 12 }, (_, index) => index + 1),
          explanation:
            "School notice requirement identified in the synthetic source.",
          proposals: [
            {
              title: "Share school notices",
              obligationText: citation,
              pageStart: 1,
              pageEnd: 1,
              citationText: citation,
            },
          ],
        });
        return modelOutput;
      },
      "agreement-review-test",
      100001,
    );
    const input = { artifactId: source.id, ownerEntityId: SELF_ENTITY_ID };
    await expect(service.readOwnerReview(input)).resolves.toBeNull();
    await expect(
      service.prepareOwnerReview({
        ...input,
        ownerEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
    expect(calls).toBe(0);
    const [first, concurrent] = await Promise.all([
      service.prepareOwnerReview(input),
      service.prepareOwnerReview(input),
    ]);
    expect(concurrent).toEqual(first);
    expect(calls).toBe(1);
    expect(first.obligations).toHaveLength(1);
    expect(first.obligations[0]?.status).toBe("proposed");
    const recorded = (
      await trajectories.listTrajectories({
        source: "lifeops.agreement-review",
      })
    ).trajectories.filter((row) => row.metadata.artifactId === source.id);
    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    if (!entry)
      throw new Error("Owner review has no recorded model trajectory");
    const detail = await trajectories.getTrajectoryDetail(entry.id);
    if (!detail) throw new Error("Owner review trajectory cannot be read");
    expect(entry.status).toBe("completed");
    const modelCalls = detail.steps.flatMap((step) => step.llmCalls);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]?.userPrompt).toBe(modelPrompt);
    expect(modelCalls[0]?.response).toBe(modelOutput);

    await expect(service.listPins(input)).resolves.toEqual([]);
    const obligation = first.obligations[0];
    if (!obligation) throw new Error("Expected persisted proposal");
    await service.decideObligation({
      obligationId: obligation.id,
      decision: "reject",
      decidedByEntityId: SELF_ENTITY_ID,
      reason: "Owner rejected this synthetic proposal",
    });
    const restarted = createAgreementKnowledgeService(runtime);
    const replay = await restarted.prepareOwnerReview(input);
    expect(calls).toBe(1);
    expect(
      (
        await trajectories.listTrajectories({
          source: "lifeops.agreement-review",
        })
      ).trajectories.filter((row) => row.metadata.artifactId === source.id),
    ).toHaveLength(1);
    expect(
      replay.obligations.map((item) => ({ id: item.id, status: item.status })),
    ).toEqual([{ id: obligation.id, status: "rejected" }]);
    expect(
      (
        await restarted.readFor({
          artifactId: source.id,
          principalEntityId: SELF_ENTITY_ID,
        })
      ).obligations,
    ).toHaveLength(1);
  });

  it("rejects a fabricated model citation without committing a partial review and allows a valid retry", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const source = await service.createAgreementVersion({
      agreementKey: "review-invalid-citation",
      title: "Citation rejection",
      originalFilename: "citation.pdf",
      mimeType: "application/pdf",
      bytes: pdf("A travel request remains unresolved until answered."),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () =>
        JSON.stringify({
          complete: true,
          reviewedPages: Array.from({ length: 12 }, (_, index) => index + 1),
          explanation: "Invalid output fixture",
          proposals: [
            {
              title: "Await travel response",
              obligationText:
                "A travel request remains unresolved until answered.",
              pageStart: 1,
              pageEnd: 1,
              citationText:
                "A travel request remains unresolved until answered.",
            },
            {
              title: "Travel",
              obligationText: "Silence is consent",
              pageStart: 1,
              pageEnd: 1,
              citationText: "Silence is consent",
            },
          ],
        }),
      "agreement-review-test",
      100002,
    );
    const input = { artifactId: source.id, ownerEntityId: SELF_ENTITY_ID };
    await expect(service.prepareOwnerReview(input)).rejects.toMatchObject({
      code: "AGREEMENT_REVIEW_CITATION_INVALID",
    });
    await expect(service.readOwnerReview(input)).resolves.toBeNull();
    expect(
      (
        await service.readFor({
          artifactId: source.id,
          principalEntityId: SELF_ENTITY_ID,
        })
      ).obligations,
    ).toEqual([]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () =>
        JSON.stringify({
          complete: true,
          reviewedPages: Array.from({ length: 12 }, (_, index) => index + 1),
          explanation:
            "No clear commitments identified; owner review remains necessary.",
          proposals: [],
        }),
      "agreement-review-test",
      100003,
    );
    const empty = await service.prepareOwnerReview(input);
    expect(empty.outcome).toBe("no_proposals");
    const restarted = createAgreementKnowledgeService(runtime);
    await expect(restarted.readOwnerReview(input)).resolves.toEqual(empty);
  });
  it("commits one review across service instances and rolls back the entire batch when its audit fails", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const citation = "Each parent must acknowledge receipt of school notices.";
    const source = await service.createAgreementVersion({
      agreementKey: "review-transaction-recovery",
      title: "Transactional review",
      originalFilename: "transaction.pdf",
      mimeType: "application/pdf",
      bytes: pdf(citation),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    let calls = 0;
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => {
        calls += 1;
        return JSON.stringify({
          complete: true,
          reviewedPages: Array.from({ length: 12 }, (_, index) => index + 1),
          explanation: "Synthetic notice receipt requirement.",
          proposals: [
            {
              title: "Acknowledge notice",
              obligationText: citation,
              citationText: citation,
              pageStart: 1,
              pageEnd: 1,
            },
          ],
        });
      },
      "agreement-review-test",
      100004,
    );
    const input = { artifactId: source.id, ownerEntityId: SELF_ENTITY_ID };
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_lifeops.reject_prepared_review_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Prepared review audit unavailable'; END $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_prepared_review_test BEFORE INSERT ON app_lifeops.life_audit_events
      FOR EACH ROW WHEN (NEW.event_type = 'agreement_review_prepared') EXECUTE FUNCTION app_lifeops.reject_prepared_review_test()`,
    );
    try {
      await expect(service.prepareOwnerReview(input)).rejects.toThrow();
      await expect(service.readOwnerReview(input)).resolves.toBeNull();
      const readback = await service.readFor({
        artifactId: source.id,
        principalEntityId: SELF_ENTITY_ID,
      });
      expect(readback.obligations).toEqual([]);
      const audit = await executeRawSql(
        runtime,
        `SELECT id FROM app_lifeops.life_audit_events
        WHERE owner_id = '${source.id}' AND event_type = 'agreement_obligation_proposed'`,
      );
      expect(audit).toEqual([]);
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_prepared_review_test ON app_lifeops.life_audit_events",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_prepared_review_test()",
      );
    }
    const second = createAgreementKnowledgeService(runtime);
    const [first, concurrent] = await Promise.all([
      service.prepareOwnerReview(input),
      second.prepareOwnerReview(input),
    ]);
    expect(first).toEqual(concurrent);
    expect(first.obligations).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    const readback = await service.readFor({
      artifactId: source.id,
      principalEntityId: SELF_ENTITY_ID,
    });
    expect(readback.obligations.map((item) => item.id)).toEqual(
      first.obligations.map((item) => item.id),
    );
    await expect(
      createAgreementKnowledgeService(runtime).readOwnerReview(input),
    ).resolves.toEqual(first);
  });

  it.each(["artifact", "document", "fragment"] as const)(
    "removes private sources when %s persistence rejects the upload",
    async (boundary) => {
      const media = path.join(mediaStateDir, "media");
      fs.mkdirSync(media, { recursive: true });
      const filesBefore = fs.readdirSync(media).sort();
      const documentRows = () =>
        executeRawSql(
          runtime,
          `SELECT id FROM memories WHERE agent_id = ${sqlQuote(runtime.agentId)}
          AND type IN ('documents', 'document_fragments') ORDER BY id`,
        );
      const docsBefore = await documentRows();
      const table =
        boundary === "artifact"
          ? "app_lifeops.life_household_agreement_artifacts"
          : "memories";
      await executeRawSql(
        runtime,
        `CREATE FUNCTION app_lifeops.reject_ingest_acceptance()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          ${boundary !== "artifact" ? `IF NEW.type <> '${boundary === "document" ? "documents" : "document_fragments"}' THEN RETURN NEW; END IF;` : ""}
          RAISE EXCEPTION 'forced upload persistence rejection'; END; $$`,
      );
      await executeRawSql(
        runtime,
        `CREATE TRIGGER reject_ingest_acceptance
        BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_ingest_acceptance()`,
      );
      try {
        await expect(
          createAgreementKnowledgeService(runtime).createAgreementVersion({
            agreementKey: `rollback-${boundary}`,
            title: "Rollback boundary acceptance",
            originalFilename: "rollback.pdf",
            mimeType: "application/pdf",
            bytes: pdf(`private upload rejected by ${boundary} persistence`),
            uploadedByEntityId: SELF_ENTITY_ID,
          }),
        ).rejects.toThrow();
        expect(await documentRows()).toEqual(docsBefore);
        expect(fs.readdirSync(media).sort()).toEqual(filesBefore);
        expect(
          await new AgreementKnowledgeRepository(
            runtime,
            runtime.agentId,
          ).getArtifactByContent({
            householdId: DEFAULT_HOUSEHOLD_ID,
            agreementKey: `rollback-${boundary}`,
            contentSha256: crypto
              .createHash("sha256")
              .update(pdf(`private upload rejected by ${boundary} persistence`))
              .digest("hex"),
          }),
        ).toBeNull();
      } finally {
        await executeRawSql(
          runtime,
          `DROP TRIGGER reject_ingest_acceptance ON ${table}`,
        );
        await executeRawSql(
          runtime,
          `DROP FUNCTION app_lifeops.reject_ingest_acceptance()`,
        );
      }
    },
  );

  it("keeps identical source PDFs in separate agreement families independently readable", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const bytes = pdf("same source, independently owned agreement families");
    const input = {
      title: "Shared source",
      originalFilename: "shared-source.pdf",
      mimeType: "application/pdf",
      bytes,
      uploadedByEntityId: SELF_ENTITY_ID,
    };
    const first = await service.createAgreementVersion({
      ...input,
      agreementKey: "independent-source-first",
    });
    const second = await service.createAgreementVersion({
      ...input,
      agreementKey: "independent-source-second",
    });
    expect(second.documentId).not.toBe(first.documentId);
    for (const artifact of [first, second]) {
      expect(
        (
          await service.readOwnerPdf({
            artifactId: artifact.id,
            ownerEntityId: SELF_ENTITY_ID,
          })
        ).bytes,
      ).toEqual(bytes);
      const document = await runtime.getMemoryById(artifact.documentId as UUID);
      expect(document?.metadata?.mediaFileName).toBe(artifact.mediaFileName);
    }
  });

  it("rolls back a concurrent duplicate without removing the winning agreement sources", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const media = path.join(mediaStateDir, "media");
    fs.mkdirSync(media, { recursive: true });
    const filesBefore = new Set(fs.readdirSync(media));
    const bytes = pdf("simultaneous immutable agreement upload");
    const input = {
      agreementKey: "concurrent-upload-rollback",
      title: "Concurrent source",
      originalFilename: "concurrent-source.pdf",
      mimeType: "application/pdf",
      bytes,
      uploadedByEntityId: SELF_ENTITY_ID,
    };
    const results = await Promise.allSettled([
      service.createAgreementVersion(input),
      service.createAgreementVersion(input),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = fulfilled[0];
    if (!winner) throw new Error("No persisted upload winner");
    const artifact = winner.value;
    expect(
      (
        await service.readOwnerPdf({
          artifactId: artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        })
      ).bytes,
    ).toEqual(bytes);
    expect(
      fs.readdirSync(media).filter((file) => !filesBefore.has(file)),
    ).toEqual([artifact.mediaFileName]);
    const documents = await executeRawSql(
      runtime,
      `SELECT id FROM memories
      WHERE agent_id = ${sqlQuote(runtime.agentId)} AND type = 'documents'
      AND metadata->>'agreementKey' = ${sqlQuote(input.agreementKey)}`,
    );
    expect(documents.map((row) => row.id)).toEqual([artifact.documentId]);
    const document = await runtime.getMemoryById(artifact.documentId as UUID);
    expect(document?.metadata?.mediaFileName).toBe(artifact.mediaFileName);
  });
  it.each(["committed", "unreadable"] as const)(
    "preserves source data when a lost commit acknowledgement is %s",
    async (observation) => {
      class LostAcknowledgementRepository extends AgreementKnowledgeRepository {
        persisted: ParentingAgreementArtifact | null = null;
        override async insertArtifact(
          input: Parameters<AgreementKnowledgeRepository["insertArtifact"]>[0],
        ) {
          this.persisted = await super.insertArtifact(input);
          throw new Error("Simulated lost commit acknowledgement");
        }
        override async getArtifact(id: string) {
          if (observation === "unreadable")
            throw new Error("Commit observation unavailable");
          return super.getArtifact(id);
        }
      }
      const repository = new LostAcknowledgementRepository(
        runtime,
        runtime.agentId,
      );
      const graph = resolveKnowledgeGraphService(runtime);
      if (!graph) throw new Error("Real graph service unavailable");
      const service = new AgreementKnowledgeService({
        runtime,
        agentId: runtime.agentId,
        household,
        entityStore: graph.getEntityStore(runtime.agentId),
        repository,
        fileStorage: () =>
          runtime.getService<IFileStorageService>(ServiceType.REMOTE_FILES),
        documents: () =>
          runtime.getService<DocumentService>(DocumentService.serviceType),
        pdf: () => runtime.getService<PdfService>(ServiceType.PDF),
      });
      const bytes = pdf(`persisted upload with ${observation} acknowledgement`);
      await expect(
        service.createAgreementVersion({
          agreementKey: `lost-ack-${observation}`,
          title: "Commit observation",
          originalFilename: "commit-observation.pdf",
          mimeType: "application/pdf",
          bytes,
          uploadedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({
        code: "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
      });
      const persisted = repository.persisted;
      if (!persisted)
        throw new Error("The fault must occur after a real commit");
      const restored = createAgreementKnowledgeService(runtime);
      expect(
        (
          await restored.readOwnerPdf({
            artifactId: persisted.id,
            ownerEntityId: SELF_ENTITY_ID,
          })
        ).bytes,
      ).toEqual(bytes);
      expect(
        await runtime.getMemoryById(persisted.documentId as UUID),
      ).not.toBeNull();
      // Source reads above reconcile the injected lost acknowledgement before
      // this synthetic test operation is settled. Uninspected claims stay open.
      const claims = await executeRawSql(
        runtime,
        `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      expect(claims).toHaveLength(1);
      await settleFamilyWorkspaceOperation(
        runtime,
        String(claims[0].operation_id),
      );
    },
  );

  it("reports incomplete cleanup when the document store rejects deletion", async () => {
    const key = "rollback-delete-outage";
    const documents = runtime.getService<DocumentService>(
      DocumentService.serviceType,
    );
    if (!documents)
      throw new Error("Real document service unavailable for teardown");
    const media = path.join(mediaStateDir, "media");
    fs.mkdirSync(media, { recursive: true });
    const before = fs.readdirSync(media).sort();
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_lifeops.reject_rollback_acceptance()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced lifecycle storage outage'; END; $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_rollback_artifact BEFORE INSERT
      ON app_lifeops.life_household_agreement_artifacts FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_rollback_acceptance()`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_rollback_document BEFORE DELETE
      ON memories FOR EACH ROW WHEN (OLD.type = 'documents') EXECUTE FUNCTION app_lifeops.reject_rollback_acceptance()`,
    );
    try {
      await expect(
        createAgreementKnowledgeService(runtime).createAgreementVersion({
          agreementKey: key,
          title: "Cleanup outage",
          originalFilename: "cleanup-outage.pdf",
          mimeType: "application/pdf",
          bytes: pdf("document cleanup unavailable"),
          uploadedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_INGESTION_CLEANUP_FAILED" });
      expect(fs.readdirSync(media).sort()).toEqual(before);
      const rows = await executeRawSql(
        runtime,
        `SELECT id FROM memories
        WHERE agent_id = ${sqlQuote(runtime.agentId)} AND type = 'documents'
        AND metadata->>'agreementKey' = ${sqlQuote(key)}`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_rollback_artifact ON app_lifeops.life_household_agreement_artifacts",
      );
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_rollback_document ON memories",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_rollback_acceptance()",
      );
      const rows = await executeRawSql(
        runtime,
        `SELECT id FROM memories
        WHERE agent_id = ${sqlQuote(runtime.agentId)} AND type = 'documents'
        AND metadata->>'agreementKey' = ${sqlQuote(key)}`,
      );
      for (const row of rows)
        await documents.deleteDocumentWithAccessContext(
          String(row.id) as UUID,
          { requesterEntityId: runtime.agentId, role: "OWNER" },
        );
      // The real document delete has now completed the compensation that the
      // injected outage interrupted; only then may its operation claim settle.
      const claims = await executeRawSql(
        runtime,
        `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      expect(claims).toHaveLength(1);
      await settleFamilyWorkspaceOperation(
        runtime,
        String(claims[0].operation_id),
      );
    }
  });
  it("rejects a reviewed deletion after new versions or pins and rolls back failed revocation", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const input = {
      agreementKey: "deletion-snapshot-family",
      title: "Deletion snapshot fixture",
      originalFilename: "deletion.pdf",
      mimeType: "application/pdf",
      bytes: pdf("deletion v1"),
      uploadedByEntityId: SELF_ENTITY_ID,
    };
    const first = await service.createAgreementVersion(input);
    const selection = {
      householdId: first.householdId,
      agreementKey: first.agreementKey,
    };
    const request = { ownerEntityId: SELF_ENTITY_ID, selection };
    const reviewed = await previewAgreementDeletion(runtime, request);
    let entered = false;
    const observe = async () => {
      entered = true;
    };
    await expect(
      previewAgreementDeletion(runtime, {
        ...request,
        ownerEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
    await service.createAgreementVersion({
      ...input,
      bytes: pdf("deletion v2"),
    });
    await expect(
      withReviewedAgreementDeletion(
        runtime,
        { ...request, expectedSha256: reviewed.sha256 },
        observe,
      ),
    ).rejects.toMatchObject({ code: "AGREEMENT_DELETION_PREVIEW_STALE" });
    expect(entered).toBe(false);
    const afterVersion = await previewAgreementDeletion(runtime, request);
    await service.pin({
      artifactId: first.id,
      targetType: "agent",
      targetId: runtime.agentId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      withReviewedAgreementDeletion(
        runtime,
        { ...request, expectedSha256: afterVersion.sha256 },
        observe,
      ),
    ).rejects.toMatchObject({ code: "AGREEMENT_DELETION_PREVIEW_STALE" });
    expect(entered).toBe(false);
    const afterPin = await previewAgreementDeletion(runtime, request);
    // An unrelated agreement must not invalidate the reviewed selection.
    await service.createAgreementVersion({
      ...input,
      agreementKey: "unrelated-deletion-family",
      bytes: pdf("unrelated"),
    });
    await expect(
      withReviewedAgreementDeletion(
        runtime,
        { ...request, expectedSha256: afterPin.sha256 },
        async (tx) => {
          await executeRawSqlTx(
            tx,
            `UPDATE app_lifeops.life_household_knowledge_pins SET unpinned_at = '2026-09-13T00:00:00Z' WHERE agent_id = ${sqlQuote(runtime.agentId)} AND artifact_id = ${sqlQuote(first.id)}`,
          );
          throw new Error("Synthetic revocation failure");
        },
      ),
    ).rejects.toThrow("Synthetic revocation failure");
    const afterFailure = await previewAgreementDeletion(runtime, request);
    expect(afterFailure.sha256).toBe(afterPin.sha256);
    await withReviewedAgreementDeletion(
      runtime,
      { ...request, expectedSha256: afterFailure.sha256 },
      observe,
    );
    expect(entered).toBe(true);
  });
  it("invalidates deletion when a referenced packet or draft appears without treating prose as a dependency", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const source = await service.createAgreementVersion({
      agreementKey: "packet-deletion-family",
      title: "Packet dependency fixture",
      originalFilename: "packet-dependency.pdf",
      mimeType: "application/pdf",
      bytes: pdf("packet deletion source"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    const request = {
      ownerEntityId: SELF_ENTITY_ID,
      selection: {
        householdId: source.householdId,
        agreementKey: source.agreementKey,
      },
    };
    const before = await previewAgreementDeletion(runtime, request);
    const packets = new MonthlyFamilyPacketService(runtime);
    const packet = await packets.buildInternal(
      {
        key: "2030-01",
        startsOn: "2030-01-01",
        endsOnExclusive: "2030-02-01",
        timeZone: "UTC",
      },
      [
        {
          claimId: "typed-agreement-dependency",
          stableKey: "typed-agreement-dependency",
          section: "unanswered",
          statement: "Review a source-dependent question.",
          visibility: "owner_only",
          provenance: [
            {
              source: "knowledge",
              sourceId: source.id,
              observedAt: source.createdAt,
              contentSha256: source.contentSha256,
            },
          ],
          dates: [],
          requests: [],
          urgency: null,
          commitments: [],
          accountability: [],
        },
      ],
    );
    let revoked = false;
    const revoke = async () => {
      revoked = true;
    };
    await expect(
      withReviewedAgreementDeletion(
        runtime,
        { ...request, expectedSha256: before.sha256 },
        revoke,
      ),
    ).rejects.toMatchObject({ code: "AGREEMENT_DELETION_PREVIEW_STALE" });
    expect(revoked).toBe(false);
    const withPacket = await previewAgreementDeletion(runtime, request);
    await packets.createExternalDraft(packet, {
      recipient: "Synthetic reviewer",
      recipientEntityId: "verified-co-parent",
      calendarPrivacyMode: "busy_only",
    });
    await expect(
      withReviewedAgreementDeletion(
        runtime,
        { ...request, expectedSha256: withPacket.sha256 },
        revoke,
      ),
    ).rejects.toMatchObject({ code: "AGREEMENT_DELETION_PREVIEW_STALE" });
    expect(revoked).toBe(false);
    const withDraft = await previewAgreementDeletion(runtime, request);
    const unrelated = await packets.buildInternal(
      {
        key: "2030-02",
        startsOn: "2030-02-01",
        endsOnExclusive: "2030-03-01",
        timeZone: "UTC",
      },
      [
        {
          claimId: "unrelated-prose",
          stableKey: "unrelated-prose",
          section: "unanswered",
          statement: `This unrelated text mentions ${source.id}.`,
          visibility: "owner_only",
          provenance: [
            {
              source: "knowledge",
              sourceId: "unrelated-record",
              observedAt: source.createdAt,
              contentSha256: source.contentSha256,
            },
          ],
          dates: [],
          requests: [],
          urgency: null,
          commitments: [],
          accountability: [],
        },
      ],
    );
    await withReviewedAgreementDeletion(
      runtime,
      { ...request, expectedSha256: withDraft.sha256 },
      revoke,
    );
    expect(revoked).toBe(true);
    await executeRawSql(
      runtime,
      "ALTER TABLE app_lifeops.life_family_packet_drafts RENAME TO deletion_test_unavailable_drafts",
    );
    let incomplete: Awaited<ReturnType<typeof previewAgreementDeletion>>;
    try {
      incomplete = await previewAgreementDeletion(runtime, request);
      await expect(
        withReviewedAgreementDeletion(
          runtime,
          { ...request, expectedSha256: incomplete.sha256 },
          revoke,
        ),
      ).rejects.toMatchObject({
        code: "AGREEMENT_DELETION_DEPENDENCIES_UNAVAILABLE",
      });
    } finally {
      await executeRawSql(
        runtime,
        "ALTER TABLE app_lifeops.deletion_test_unavailable_drafts RENAME TO life_family_packet_drafts",
      );
    }
    await expect(
      withReviewedAgreementDeletion(
        runtime,
        { ...request, expectedSha256: incomplete.sha256 },
        revoke,
      ),
    ).rejects.toMatchObject({ code: "AGREEMENT_DELETION_PREVIEW_STALE" });

    for (const invalid of [
      "{}",
      JSON.stringify({
        claims: [
          { provenance: [{ source: "unrecognized", sourceId: source.id }] },
        ],
      }),
    ]) {
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_family_packets SET packet_json = ${sqlQuote(invalid)} WHERE agent_id = ${sqlQuote(runtime.agentId)} AND packet_id = ${sqlQuote(unrelated.packetId)}`,
      );
      try {
        await expect(
          previewAgreementDeletion(runtime, request),
        ).rejects.toMatchObject({
          code: "AGREEMENT_DELETION_SNAPSHOT_INVALID",
        });
      } finally {
        await executeRawSql(
          runtime,
          `UPDATE app_lifeops.life_family_packets SET packet_json = ${sqlQuote(JSON.stringify(unrelated))} WHERE agent_id = ${sqlQuote(runtime.agentId)} AND packet_id = ${sqlQuote(unrelated.packetId)}`,
        );
      }
    }
  });
  it("reviews all agreement families and derived documents without including another agent", async () => {
    await new CalendarCardAccessStore(runtime).ensureSchema();
    const service = createAgreementKnowledgeService(runtime);
    const first = await service.createAgreementVersion({
      agreementKey: "workspace-snapshot-first",
      title: "Workspace first",
      originalFilename: "workspace-first.pdf",
      mimeType: "application/pdf",
      bytes: pdf("workspace database first"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    const before = await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID);
    expect(
      before.records
        .filter((row) => row.kind === "agreements")
        .map((row) => row.identity.id),
    ).toContain(first.id);
    expect(
      before.records
        .filter((row) => row.kind === "documents")
        .map((row) => row.identity.id),
    ).toContain(first.documentId);
    expect(before.records.some((row) => row.kind === "documentFragments")).toBe(
      true,
    );
    await expect(
      previewFamilyDeletionDatabase(runtime, "verified-co-parent"),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_ACCESS_DENIED" });
    const second = await service.createAgreementVersion({
      agreementKey: "workspace-snapshot-second",
      title: "Workspace second",
      originalFilename: "workspace-second.pdf",
      mimeType: "application/pdf",
      bytes: pdf("workspace database second"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    const expanded = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(expanded.sha256).not.toBe(before.sha256);
    expect(
      expanded.records
        .filter((row) => row.kind === "agreements")
        .map((row) => row.identity.id),
    ).toEqual(expect.arrayContaining([first.id, second.id]));
    const foreignId = `hag_${crypto.randomUUID()}`;
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Real private file storage unavailable");
    const foreignFile = await storage.storePrivate(
      pdf("independent foreign workspace PDF"),
      "application/pdf",
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_household_agreement_artifacts SELECT (jsonb_populate_record(NULL::app_lifeops.life_household_agreement_artifacts, to_jsonb(source) || jsonb_build_object('id', ${sqlQuote(foreignId)}, 'agent_id', ${sqlQuote(crypto.randomUUID())}, 'document_id', ${sqlQuote(crypto.randomUUID())}, 'media_file_name', ${sqlQuote(foreignFile.fileName)}, 'content_sha256', ${sqlQuote(foreignFile.hash)}, 'byte_size', ${foreignFile.size}))).* FROM app_lifeops.life_household_agreement_artifacts source WHERE id = ${sqlQuote(first.id)}`,
    );
    const afterForeign = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(afterForeign.unavailable).toEqual([]);
    expect(afterForeign.sha256).toBe(expanded.sha256);
    expect(
      afterForeign.records
        .filter((row) => row.kind === "agreements")
        .map((row) => row.identity.id),
    ).not.toContain(foreignId);
    let entered = false;
    await expect(
      withReviewedFamilyDeletionDatabase(
        runtime,
        { ownerEntityId: SELF_ENTITY_ID, expectedSha256: before.sha256 },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toMatchObject({
      code: "FAMILY_DELETION_PREVIEW_STALE",
    });
    expect(entered).toBe(false);
  });
  it("blocks reviewed deletion while school writes or family message receipts remain unresolved", async () => {
    await new CalendarCardAccessStore(runtime).ensureSchema();
    const agent = sqlQuote(runtime.agentId);
    const source = sqlQuote(crypto.randomUUID());
    const run = sqlQuote(crypto.randomUUID());
    const at = sqlQuote(new Date().toISOString());
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_school_calendar_sources
      (agent_id,source_id,config_json,created_at,updated_at) VALUES (${agent},${source},'{}',${at},${at})`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_school_calendar_runs
      (agent_id,run_id,source_id,state,trigger_kind,created_at,updated_at) VALUES (${agent},${run},${source},'awaiting_approval','manual',${at},${at})`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_school_calendar_apply_operations
      (agent_id,run_id,operation_index,event_key,kind,change_json,state,created_at,updated_at)
      VALUES (${agent},${run},0,'deletion-guard-event','create','{}','pending',${at},${at})`,
    );
    const cases = [
      {
        table: "app_lifeops.life_school_calendar_sources",
        where: `source_id=${source}`,
        busy: "lease_token='private-lease',lease_expires_at='2000-01-01T00:00:00Z'",
        idle: "lease_token=NULL,lease_expires_at=NULL",
        kind: "schoolSources",
      },
      {
        table: "app_lifeops.life_school_calendar_runs",
        where: `run_id=${run}`,
        busy: "state='applying'",
        idle: "state='awaiting_approval'",
        kind: "schoolRuns",
      },
      {
        table: "app_lifeops.life_school_calendar_apply_operations",
        where: `run_id=${run}`,
        busy: "state='executing'",
        idle: "state='pending'",
        kind: "schoolMutations",
      },
      {
        table: "approval_requests",
        where:
          "id::text IN (SELECT approval_id FROM app_lifeops.life_family_packet_approvals)",
        busy: "state='reconciliation_required'",
        idle: "state='executed'",
        kind: "approvals",
      },
    ];
    for (const candidate of cases) {
      await executeRawSql(
        runtime,
        `UPDATE ${candidate.table} SET ${candidate.busy} WHERE agent_id::text=${agent} AND ${candidate.where}`,
      );
      try {
        const preview = await previewFamilyDeletionDatabase(
          runtime,
          SELF_ENTITY_ID,
        );
        expect(
          preview.records.some(
            (record) => record.kind === candidate.kind && record.unsettled,
          ),
        ).toBe(true);
        expect(JSON.stringify(preview)).not.toContain("private-lease");
        let entered = false;
        await expect(
          withReviewedFamilyDeletionDatabase(
            runtime,
            { ownerEntityId: SELF_ENTITY_ID, expectedSha256: preview.sha256 },
            async () => {
              entered = true;
            },
          ),
        ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
        expect(entered).toBe(false);
      } finally {
        await executeRawSql(
          runtime,
          `UPDATE ${candidate.table} SET ${candidate.idle} WHERE agent_id::text=${agent} AND ${candidate.where}`,
        );
      }
    }
    const settled = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    let entered = false;
    await withReviewedFamilyDeletionDatabase(
      runtime,
      { ownerEntityId: SELF_ENTITY_ID, expectedSha256: settled.sha256 },
      async () => {
        entered = true;
      },
    );
    expect(entered).toBe(true);
  });
  it("fingerprints private workflow lease changes without disclosing tokens and rolls back failed workspace revocation", async () => {
    await new CalendarCardAccessStore(runtime).ensureSchema();
    await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID);
    const period = "2042-03";
    const lease = crypto.randomUUID();
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_family_workflow_runs
      (agent_id, period_key, run_id, state, trigger_kind, lease_token, lease_expires_at, created_at, updated_at)
      VALUES (${sqlQuote(runtime.agentId)}, ${sqlQuote(period)}, 'database-preview-run', 'running', 'manual', ${sqlQuote(lease)}, '2042-03-01T00:10:00Z', '2042-03-01T00:00:00Z', '2042-03-01T00:00:00Z')`,
    );
    const before = await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID);
    expect(before.unavailable).toEqual([]);
    expect(
      before.records.find(
        (row) =>
          row.kind === "workflowRuns" && row.identity.period_key === period,
      ),
    ).toBeDefined();
    expect(JSON.stringify(before)).not.toContain(lease);
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_family_workflow_runs SET lease_token = ${sqlQuote(crypto.randomUUID())} WHERE agent_id = ${sqlQuote(runtime.agentId)} AND period_key = ${sqlQuote(period)}`,
    );
    const changed = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(changed.sha256).not.toBe(before.sha256);
    let entered = false;
    await expect(
      withReviewedFamilyDeletionDatabase(
        runtime,
        { ownerEntityId: SELF_ENTITY_ID, expectedSha256: before.sha256 },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_PREVIEW_STALE" });
    expect(entered).toBe(false);
    await expect(
      withReviewedFamilyDeletionDatabase(
        runtime,
        { ownerEntityId: SELF_ENTITY_ID, expectedSha256: changed.sha256 },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    expect(entered).toBe(false);
    // Expiry cannot prove a provider request stopped. Only a settled executor
    // releases the lease; a fresh review is then required before revocation.
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_family_workflow_runs SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE agent_id = ${sqlQuote(runtime.agentId)} AND period_key = ${sqlQuote(period)}`,
    );
    const expired = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    await expect(
      withReviewedFamilyDeletionDatabase(
        runtime,
        { ownerEntityId: SELF_ENTITY_ID, expectedSha256: expired.sha256 },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    expect(entered).toBe(false);
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_family_workflow_runs SET state = 'completed', lease_token = NULL, lease_expires_at = NULL WHERE agent_id = ${sqlQuote(runtime.agentId)} AND period_key = ${sqlQuote(period)}`,
    );
    const settled = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    await expect(
      withReviewedFamilyDeletionDatabase(
        runtime,
        { ownerEntityId: SELF_ENTITY_ID, expectedSha256: settled.sha256 },
        async (tx) => {
          await executeRawSqlTx(
            tx,
            `UPDATE app_lifeops.life_family_workflow_runs SET state = 'failed' WHERE agent_id = ${sqlQuote(runtime.agentId)} AND period_key = ${sqlQuote(period)}`,
          );
          throw new Error("Revocation transaction failed");
        },
      ),
    ).rejects.toThrow("Revocation transaction failed");
    expect(
      (await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID)).sha256,
    ).toBe(settled.sha256);
  });
  it.each([false, true])(
    "retries retained staged bytes after settled extraction failure (modelUnavailable=%s)",
    async (modelUnavailable) => {
      const agreementKey = modelUnavailable
        ? "settled-model-outage-retry"
        : "settled-extraction-retry";
      const bytes = pdf(
        "retry complete extraction without duplicating sources",
      );
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const upload = await beginAgreementUpload(runtime, {
        agreementKey,
        title: "Settled extraction retry",
        originalFilename: "retry.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      });
      const staged = await acceptAgreementChunk({
        runtime,
        uploadId: upload.uploadId,
        index: 0,
        bytes,
        sha256: hash,
      });
      const contentIdentity = crypto
        .createHash("sha256")
        .update(
          [
            "agreement-upload-content-v1",
            String(bytes.length),
            String(staged.chunkSizeBytes),
            `0:${bytes.length}:${hash}`,
          ].join("\n"),
        )
        .digest("hex");
      const service = createAgreementKnowledgeService(runtime);
      const repository = new AgreementKnowledgeRepository(
        runtime,
        runtime.agentId,
      );
      const input = {
        runtime,
        uploadId: upload.uploadId,
        contentIdentity,
        createArtifact: async ({ bytes: assembled }: { bytes: Buffer }) =>
          service.createAgreementVersion({
            agreementKey,
            title: "Settled extraction retry",
            originalFilename: "retry.pdf",
            mimeType: "application/pdf",
            bytes: assembled,
            uploadedByEntityId: SELF_ENTITY_ID,
          }),
        readArtifact: async (id: string) => {
          const artifact = await repository.getArtifact(id);
          if (!artifact) throw new Error("Committed artifact is missing");
          return artifact;
        },
      };
      const extraction = vi
        .spyOn(AgreementTestPdfService.prototype, "extractCompleteDocument")
        .mockRejectedValueOnce(
          modelUnavailable
            ? new ElizaError("Transcription dependency unavailable", {
                code: "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE",
              })
            : new Error("Transcription dependency unavailable"),
        );
      try {
        await expect(commitAgreementUpload(input)).rejects.toMatchObject({
          code: modelUnavailable
            ? "AGREEMENT_EXTRACTION_UNAVAILABLE"
            : "AGREEMENT_INVALID_CONTRACT",
          cause: { message: "Transcription dependency unavailable" },
        });
      } finally {
        extraction.mockRestore();
      }
      const pending = await readAgreementUpload(runtime, upload.uploadId);
      expect(pending.status).toBe("uploading");
      expect(
        await repository.getArtifactByContent({
          householdId: DEFAULT_HOUSEHOLD_ID,
          agreementKey,
          contentSha256: hash,
        }),
      ).toBeNull();
      const storage = runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      if (!storage) throw new Error("Canonical storage is unavailable");
      expect(await storage.readPrivate(pending.chunks[0].fileName)).toEqual(
        bytes,
      );
      const preview = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      expect(
        preview.records.filter((row) => row.kind === "workspaceOperations"),
      ).toEqual([]);
      const committed = await commitAgreementUpload(input);
      expect(committed.created).toBe(true);
      const replay = await commitAgreementUpload(input);
      expect(replay.created).toBe(false);
      expect(replay.artifact.id).toBe(committed.artifact.id);
      expect(
        (
          await service.readOwnerPdf({
            artifactId: committed.artifact.id,
            ownerEntityId: SELF_ENTITY_ID,
          })
        ).bytes,
      ).toEqual(bytes);
      expect(await storage.readPrivate(pending.chunks[0].fileName)).toBeNull();
    },
  );

  it("holds durable admission through staged chunk persistence and real artifact commit", async () => {
    const bytes = pdf(
      "staged mutation guarded across private persistence and ingestion",
    );
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const upload = await beginAgreementUpload(runtime, {
      agreementKey: "guarded-staging",
      title: "Guarded staging",
      originalFilename: "guarded.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
    });
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Canonical storage is unavailable");
    const original = storage.storePrivate.bind(storage);
    let entered!: () => void;
    let release!: () => void;
    const enteredStorage = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.storePrivate = async (...args) => {
      const stored = await original(...args);
      entered();
      await released;
      return stored;
    };
    const writing = acceptAgreementChunk({
      runtime,
      uploadId: upload.uploadId,
      index: 0,
      bytes,
      sha256: hash,
    });
    try {
      await Promise.race([
        enteredStorage,
        writing.then(() => {
          throw new Error("Chunk bypassed storage barrier");
        }),
      ]);
      await expect(
        beginFamilyWorkspaceOperation(runtime, {
          kind: "agreement-upload-chunk",
          uploadId: upload.uploadId,
          index: 0,
          contentSha256: hash,
        }),
      ).rejects.toMatchObject({ code: "FAMILY_OPERATION_UNSETTLED" });
      const preview = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      let enteredDeletion = false;
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          { ownerEntityId: SELF_ENTITY_ID, expectedSha256: preview.sha256 },
          async () => {
            enteredDeletion = true;
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
      expect(enteredDeletion).toBe(false);
    } finally {
      release();
      storage.storePrivate = original;
    }
    const staged = await writing;
    const service = createAgreementKnowledgeService(runtime);
    const identity = crypto
      .createHash("sha256")
      .update(
        [
          "agreement-upload-content-v1",
          String(bytes.length),
          String(staged.chunkSizeBytes),
          `0:${bytes.length}:${hash}`,
        ].join("\n"),
      )
      .digest("hex");
    const committed = await commitAgreementUpload({
      runtime,
      uploadId: upload.uploadId,
      contentIdentity: identity,
      createArtifact: async ({ bytes: assembled }) => {
        const preview = await previewFamilyDeletionDatabase(
          runtime,
          SELF_ENTITY_ID,
        );
        let enteredDeletion = false;
        await expect(
          withReviewedFamilyDeletionDatabase(
            runtime,
            { ownerEntityId: SELF_ENTITY_ID, expectedSha256: preview.sha256 },
            async () => {
              enteredDeletion = true;
            },
          ),
        ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
        expect(enteredDeletion).toBe(false);
        return service.createAgreementVersion({
          agreementKey: "guarded-staging",
          title: "Guarded staging",
          originalFilename: "guarded.pdf",
          mimeType: "application/pdf",
          bytes: assembled,
          uploadedByEntityId: SELF_ENTITY_ID,
        });
      },
      readArtifact: async (id) => {
        const artifact = await new AgreementKnowledgeRepository(
          runtime,
          runtime.agentId,
        ).getArtifact(id);
        if (!artifact) throw new Error("Expected a committed artifact");
        return artifact;
      },
    });
    expect(
      (
        await service.readOwnerPdf({
          artifactId: committed.artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        })
      ).bytes,
    ).toEqual(bytes);
    expect(await storage.readPrivate(staged.chunks[0].fileName)).toBeNull();
    expect(
      (
        await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID)
      ).records.filter((row) => row.kind === "workspaceOperations"),
    ).toEqual([]);
    expect(
      await runtime.deleteCache(
        `lifeops:agreement-upload:v1:${upload.uploadId}`,
      ),
    ).toBe(true);
  });

  it.each(["lost-ack", "wrong-metadata"] as const)(
    "retains an uncertain private chunk claim after %s and rejects a second admission",
    async (fault) => {
      const bytes = pdf(
        "private chunk acknowledgement lost before manifest write",
      );
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const upload = await beginAgreementUpload(runtime, {
        agreementKey: "uncertain-staging",
        title: "Uncertain staging",
        originalFilename: "uncertain.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      });
      const storage = runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      if (!storage) throw new Error("Canonical storage is unavailable");
      const original = storage.storePrivate.bind(storage);
      storage.storePrivate = async (...args) => {
        const stored = await original(...args);
        if (fault === "wrong-metadata")
          return { ...stored, hash: "0".repeat(64) };
        throw new Error("Lost chunk acknowledgement");
      };
      const input = {
        runtime,
        uploadId: upload.uploadId,
        index: 0,
        bytes,
        sha256: hash,
      };
      try {
        await expect(acceptAgreementChunk(input)).rejects.toMatchObject({
          code: "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
          context: {
            target: { uploadId: upload.uploadId, contentSha256: hash },
          },
        });
        storage.storePrivate = original;
        const files = fs.readdirSync(path.join(mediaStateDir, "media")).sort();
        await expect(acceptAgreementChunk(input)).rejects.toMatchObject({
          code: "FAMILY_OPERATION_UNSETTLED",
        });
        expect(
          fs.readdirSync(path.join(mediaStateDir, "media")).sort(),
        ).toEqual(files);
      } finally {
        storage.storePrivate = original;
        const names = fs
          .readdirSync(path.join(mediaStateDir, "media"))
          .filter((name) => name.startsWith(`${hash}.`));
        expect(names).toHaveLength(1);
        for (const name of names) {
          expect(await storage.readPrivate(name)).toEqual(bytes);
          expect(await storage.deletePrivate(name)).toBe(true);
          expect(await storage.readPrivate(name)).toBeNull();
        }
        const claims = await executeRawSql(
          runtime,
          `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)} AND target_json->>'uploadId'=${sqlQuote(upload.uploadId)}`,
        );
        expect(claims).toHaveLength(1);
        await settleFamilyWorkspaceOperation(
          runtime,
          String(claims[0].operation_id),
        );
        expect(
          await runtime.deleteCache(
            `lifeops:agreement-upload:v1:${upload.uploadId}`,
          ),
        ).toBe(true);
      }
    },
  );

  it("includes staged private upload dependencies and rejects a preview after its manifest changes", async () => {
    const bytes = pdf("staged source awaiting owner completion");
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "staged-deletion-preview",
      title: "Private staged title",
      originalFilename: "staged.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
    });
    const cacheKey = `lifeops:agreement-upload:v1:${manifest.uploadId}`;
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Canonical storage is unavailable");
    const uploaded = await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 0,
      bytes,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
    try {
      expect(await storage.readPrivate(uploaded.chunks[0].fileName)).toEqual(
        bytes,
      );
      const before = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      const dependency = before.records.find(
        (record) =>
          record.kind === "agreementUploads" &&
          record.identity.key === cacheKey,
      );
      expect(dependency?.classification).toBe("owned");
      expect(JSON.stringify(before)).not.toContain(uploaded.chunks[0].fileName);
      expect(JSON.stringify(before)).not.toContain(manifest.title);
      await runtime.setCache(cacheKey, { ...uploaded, status: "committing" });
      let entered = false;
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          {
            ownerEntityId: SELF_ENTITY_ID,
            expectedSha256: before.sha256,
          },
          async () => {
            entered = true;
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_PREVIEW_STALE" });
      expect(entered).toBe(false);
      const committing = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          {
            ownerEntityId: SELF_ENTITY_ID,
            expectedSha256: committing.sha256,
          },
          async () => {
            entered = true;
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
      expect(entered).toBe(false);
      expect(await storage.readPrivate(uploaded.chunks[0].fileName)).toEqual(
        bytes,
      );
    } finally {
      for (const chunk of uploaded.chunks) {
        expect(await storage.deletePrivate(chunk.fileName)).toBe(true);
        expect(await storage.readPrivate(chunk.fileName)).toBeNull();
      }
      expect(await runtime.deleteCache(cacheKey)).toBe(true);
    }
  });

  it("correlates an unacknowledged private write with the durable claim before reconciliation", async () => {
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Canonical storage is unavailable");
    const original = storage.storePrivate.bind(storage);
    const bytes = pdf(
      "private write committed before the acknowledgement was lost",
    );
    const contentSha256 = crypto
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    storage.storePrivate = async (...args) => {
      await original(...args);
      throw new Error("Lost private-write acknowledgement");
    };
    const service = createAgreementKnowledgeService(runtime);
    try {
      await expect(
        service.createAgreementVersion({
          agreementKey: "private-write-ack-loss",
          title: "Interrupted private write",
          originalFilename: "interrupted.pdf",
          mimeType: "application/pdf",
          bytes,
          uploadedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({
        code: "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
        context: { contentSha256 },
      });
      const preview = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      const claim = preview.records.find(
        (row) => row.kind === "workspaceOperations",
      );
      if (!claim)
        throw new Error("The uncertain private write must retain its claim");
      const target = z
        .object({ artifactId: z.string(), contentSha256: z.string() })
        .parse(claim.identity.target_json);
      expect(target.contentSha256).toBe(contentSha256);
      expect(
        await new AgreementKnowledgeRepository(
          runtime,
          runtime.agentId,
        ).getArtifact(target.artifactId),
      ).toBeNull();
      const privateFile = fs
        .readdirSync(path.join(mediaStateDir, "media"))
        .find((name) => name.startsWith(`${contentSha256}.`));
      if (!privateFile)
        throw new Error("The storage fault must follow a real private write");
      expect(
        fs.readFileSync(path.join(mediaStateDir, "media", privateFile)),
      ).toEqual(bytes);
      let entered = false;
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          {
            ownerEntityId: SELF_ENTITY_ID,
            expectedSha256: preview.sha256,
          },
          async () => {
            entered = true;
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
      expect(entered).toBe(false);
    } finally {
      storage.storePrivate = original;
      // The synthetic fault has settled; inspect and remove its unique source before releasing the claim.
      const names = fs
        .readdirSync(path.join(mediaStateDir, "media"))
        .filter((name) => name.startsWith(`${contentSha256}.`));
      for (const name of names) {
        expect(
          fs.readFileSync(path.join(mediaStateDir, "media", name)),
        ).toEqual(bytes);
        expect(await storage.deletePrivate(name)).toBe(true);
        expect(await storage.readPrivate(name)).toBeNull();
      }
      const claims = await executeRawSql(
        runtime,
        `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      expect(claims).toHaveLength(1);
      await settleFamilyWorkspaceOperation(
        runtime,
        String(claims[0].operation_id),
      );
    }
  });

  it("keeps a durable claim when settlement fails after a real artifact commit", async () => {
    const bytes = pdf("committed source with interrupted operation settlement");
    const key = "operation-settlement-outage";
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_lifeops.reject_operation_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced operation settlement outage'; END; $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_operation_settlement BEFORE DELETE ON app_lifeops.life_family_workspace_operations FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_operation_settlement()`,
    );
    try {
      const service = createAgreementKnowledgeService(runtime);
      await expect(
        service.createAgreementVersion({
          agreementKey: key,
          title: "Settlement outage",
          originalFilename: "settlement.pdf",
          mimeType: "application/pdf",
          bytes,
          uploadedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({
        code: "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
      });
      const view = (
        await service.listOwnerAgreements({ ownerEntityId: SELF_ENTITY_ID })
      ).find((item) => item.artifact.agreementKey === key);
      if (!view) throw new Error("The fault must follow a persisted artifact");
      expect(
        (
          await service.readOwnerPdf({
            artifactId: view.artifact.id,
            ownerEntityId: SELF_ENTITY_ID,
          })
        ).bytes,
      ).toEqual(bytes);
      expect(
        await runtime.getMemoryById(view.artifact.documentId as UUID),
      ).not.toBeNull();
      const preview = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      expect(
        preview.records.filter((row) => row.kind === "workspaceOperations"),
      ).toHaveLength(1);
      let entered = false;
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          { ownerEntityId: SELF_ENTITY_ID, expectedSha256: preview.sha256 },
          async () => {
            entered = true;
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
      expect(entered).toBe(false);
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_operation_settlement ON app_lifeops.life_family_workspace_operations",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_operation_settlement()",
      );
      const claims = await executeRawSql(
        runtime,
        `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      expect(claims).toHaveLength(1);
      const operationId = String(claims[0].operation_id);
      await settleFamilyWorkspaceOperation(runtime, operationId);
      await expect(
        settleFamilyWorkspaceOperation(runtime, operationId),
      ).rejects.toMatchObject({ code: "FAMILY_OPERATION_SETTLEMENT_UNKNOWN" });
    }
  });

  it("includes a real warning task whose durable grant link was not acknowledged", async () => {
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_lifeops.reject_warning_link_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.scheduled_task_id IS NOT NULL THEN RAISE EXCEPTION 'warning link unavailable'; END IF;
      RETURN NEW; END $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_warning_link_test BEFORE UPDATE ON app_lifeops.life_household_grant_expiry_warning_claims FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_warning_link_test()`,
    );
    let grant: Awaited<ReturnType<HouseholdCoordinationService["issueGrant"]>>;
    try {
      grant = await household.issueGrant({
        principalEntityId: "verified-co-parent",
        role: "co_parent",
        subjectEntityIds: ["child-one"],
        scopes: ["knowledge.read"],
        issuedByEntityId: SELF_ENTITY_ID,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_warning_link_test ON app_lifeops.life_household_grant_expiry_warning_claims",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_warning_link_test()",
      );
    }
    const repository = new HouseholdCoordinationRepository(
      runtime,
      runtime.agentId,
    );
    const identityMatches = (
      task: Awaited<ReturnType<typeof runner.list>>[number],
    ) => {
      const identity = task.metadata?.householdGrantExpiryWarning;
      return (
        typeof identity === "object" &&
        identity !== null &&
        "grantId" in identity &&
        identity.grantId === grant.id
      );
    };
    const warnings = (await runner.list()).filter(identityMatches);
    expect(warnings).toHaveLength(1);
    expect(await repository.getGrantExpiryWarningTaskId(grant.id)).toBeNull();
    const preview = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    try {
      expect(
        preview.records.some(
          (row) =>
            row.kind === "scheduledTasks" &&
            row.identity.id === warnings[0].taskId,
        ),
      ).toBe(true);
    } finally {
      // Repair this actual pending intent through the canonical idempotent path.
      await ensureHouseholdGrantExpiryWarning({
        grant,
        repository,
        scheduledTasks: runner,
        now: new Date(),
      });
    }
    expect(await repository.getGrantExpiryWarningTaskId(grant.id)).toBe(
      warnings[0].taskId,
    );
    expect((await runner.list()).filter(identityMatches)).toHaveLength(1);
  });

  it("holds durable deletion admission through real scheduler dispatch and receipt persistence", async () => {
    let entered!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerScheduledTaskChannelDispatcher(runtime, {
      channelKey: "family_fence_test",
      async dispatch() {
        syntheticSchedulerDispatches += 1;
        entered();
        await resume;
        return { ok: true, channelKey: "family_fence_test" };
      },
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const task = await runner.schedule({
      kind: "recap",
      promptInstructions: "Synthetic family boundary check",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: runtime.agentId,
      ownerVisible: true,
      metadata: { systemOperation: "family.monthlyCoordination" },
      output: { destination: "channel", target: "family_fence_test:local" },
    });
    const firing = runner.fireWithResult(task.taskId);
    try {
      await Promise.race([
        dispatched,
        firing.then(() => {
          throw new Error("Family dispatch bypassed the barrier");
        }),
      ]);
      const active = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      expect(
        active.records.some(
          (row) => row.kind === "workspaceOperations" && row.unsettled,
        ),
      ).toBe(true);
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          { ownerEntityId: SELF_ENTITY_ID, expectedSha256: active.sha256 },
          (tx) => fenceFamilyWorkspace(tx, runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    } finally {
      release();
    }
    expect((await firing).kind).toBe("fired");
    const persisted = (await runner.list()).find(
      (row) => row.taskId === task.taskId,
    );
    expect(persisted?.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      channelKey: "family_fence_test",
    });
    expect(
      await executeRawSql(
        runtime,
        `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)} AND target_json->>'taskId'=${sqlQuote(task.taskId)}`,
      ),
    ).toEqual([]);
  });

  it("retains scheduled execution admission when final receipt persistence fails", async () => {
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const task = await runner.schedule({
      kind: "recap",
      promptInstructions: "Synthetic receipt failure check",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: runtime.agentId,
      ownerVisible: true,
      metadata: { systemOperation: "family.monthlyCoordination" },
      output: { destination: "channel", target: "family_fence_test:local" },
    });
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_scheduling.reject_family_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = ${sqlQuote(task.taskId)} AND NEW.metadata_json::jsonb ? 'lastDispatchResult' THEN RAISE EXCEPTION 'receipt unavailable'; END IF;
      RETURN NEW; END $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_family_receipt_test BEFORE UPDATE ON app_scheduling.life_scheduled_tasks FOR EACH ROW EXECUTE FUNCTION app_scheduling.reject_family_receipt_test()`,
    );
    const before = syntheticSchedulerDispatches;
    try {
      await expect(runner.fireWithResult(task.taskId)).rejects.toMatchObject({
        code: "FAMILY_OPERATION_RECONCILIATION_REQUIRED",
      });
      expect(syntheticSchedulerDispatches).toBe(before + 1);
      const active = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          { ownerEntityId: SELF_ENTITY_ID, expectedSha256: active.sha256 },
          (tx) => fenceFamilyWorkspace(tx, runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
      expect(
        (await runner.list()).find((row) => row.taskId === task.taskId)
          ?.metadata?.lastDispatchResult,
      ).toBeUndefined();
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_family_receipt_test ON app_scheduling.life_scheduled_tasks",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_scheduling.reject_family_receipt_test()",
      );
    }
    // Fixture-only reconciliation: the synthetic dispatcher completed once and
    // the rejected attempt has returned; dismiss its task before clearing its claim.
    await runner.apply(task.taskId, "dismiss", {
      reason: "Synthetic receipt failure reconciled",
    });
    expect(
      (await runner.list()).find((row) => row.taskId === task.taskId)?.state
        .status,
    ).toBe("dismissed");
    const claims = await executeRawSql(
      runtime,
      `SELECT operation_id FROM app_lifeops.life_family_workspace_operations WHERE agent_id=${sqlQuote(runtime.agentId)} AND target_json->>'taskId'=${sqlQuote(task.taskId)}`,
    );
    expect(claims).toHaveLength(1);
    await settleFamilyWorkspaceOperation(
      runtime,
      z.string().parse(claims[0].operation_id),
    );
  });

  it("revokes retained agreement reads and pinned context when workspace deletion starts", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const bytes = pdf("private agreement read revocation");
    const source = await service.createAgreementVersion({
      agreementKey: "read-revocation",
      title: "Read revocation",
      originalFilename: "read-revocation.pdf",
      mimeType: "application/pdf",
      bytes,
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    expect(
      (
        await service.readOwnerPdf({
          artifactId: source.id,
          ownerEntityId: SELF_ENTITY_ID,
        })
      ).bytes,
    ).toEqual(bytes);
    await ensureFamilyWorkspaceOperationStore(runtime);
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_family_workspace_state SET state='revoking' WHERE agent_id=${sqlQuote(runtime.agentId)}`,
    );
    try {
      for (const read of [
        () =>
          service.readOwnerPdf({
            artifactId: source.id,
            ownerEntityId: SELF_ENTITY_ID,
          }),
        () =>
          service.readFor({
            artifactId: source.id,
            principalEntityId: SELF_ENTITY_ID,
          }),
        () => service.listOwnerAgreements({ ownerEntityId: SELF_ENTITY_ID }),
        () => service.listApprovedObligations(),
        () => service.activePinnedContext({ ownerEntityId: SELF_ENTITY_ID }),
        () =>
          service.activePinnedContextForPrincipal({
            principalEntityId: "verified-co-parent",
          }),
        () =>
          service.exportOwnerAgreement({
            artifactId: source.id,
            ownerEntityId: SELF_ENTITY_ID,
          }),
      ])
        await expect(read()).rejects.toMatchObject({
          code: "FAMILY_WORKSPACE_FENCED",
        });
      const context = await agreementPinsProvider.get(runtime, {
        id: crypto.randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        content: {
          text: "What agreement context remains?",
          source: "eliza-client",
        },
      });
      expect(context.data).toEqual({ agreementContext: { status: "revoked" } });
      expect(context.text).not.toContain(source.title);
      await expect(
        new AgreementKnowledgeRepository(runtime, runtime.agentId).recordExport(
          {
            artifact: source,
            exportId: crypto.randomUUID(),
            ownerEntityId: SELF_ENTITY_ID,
            createdAt: new Date().toISOString(),
            manifestSha256: "a".repeat(64),
            archiveSha256: "b".repeat(64),
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
      const storage = runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      if (!storage) throw new Error("Real file storage unavailable");
      expect(await storage.readPrivate(source.mediaFileName)).toEqual(bytes);
      expect(
        await runtime.getMemoryById(source.documentId as UUID),
      ).not.toBeNull();
    } finally {
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_family_workspace_state SET state='active' WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
    }
  });

  it("rejects an owner PDF response when revocation commits during its storage read", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const source = await service.createAgreementVersion({
      agreementKey: "read-revocation-race",
      title: "Read race",
      originalFilename: "race.pdf",
      mimeType: "application/pdf",
      bytes: pdf("private bytes read before revocation"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Real file storage unavailable");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = storage.readPrivate;
    storage.readPrivate = async (fileName) => {
      const bytes = await original.call(storage, fileName);
      if (fileName === source.mediaFileName) {
        entered();
        await gate;
      }
      return bytes;
    };
    const pending = service.readOwnerPdf({
      artifactId: source.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "FAMILY_WORKSPACE_FENCED",
    });
    try {
      await started;
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_family_workspace_state SET state='revoking' WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      release();
      await rejected;
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_family_workspace_state SET state='deleted' WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      await expect(
        createAgreementKnowledgeService(runtime).readOwnerPdf({
          artifactId: source.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    } finally {
      release();
      storage.readPrivate = original;
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_family_workspace_state SET state='active' WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
    }
  });

  it("holds deletion behind real in-flight ingestion and durably fences subsequent uploads", async () => {
    const storage = runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!storage) throw new Error("Canonical storage is unavailable");
    const original = storage.storePrivate.bind(storage);
    let entered!: () => void;
    let release!: () => void;
    const enteredStorage = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumeStorage = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.storePrivate = async (...args) => {
      const stored = await original(...args);
      entered();
      await resumeStorage;
      return stored;
    };
    const input = {
      agreementKey: "fenced-ingestion",
      title: "Fenced upload",
      originalFilename: "fenced.pdf",
      mimeType: "application/pdf",
      bytes: pdf("in-flight source before durable fence"),
      uploadedByEntityId: SELF_ENTITY_ID,
    };
    const uploading =
      createAgreementKnowledgeService(runtime).createAgreementVersion(input);
    try {
      await Promise.race([
        enteredStorage,
        uploading.then(() => {
          throw new Error("Upload bypassed the storage barrier");
        }),
      ]);
      const inFlight = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      expect(
        inFlight.records.some(
          (row) => row.kind === "workspaceOperations" && row.unsettled,
        ),
      ).toBe(true);
      let fenced = false;
      await expect(
        withReviewedFamilyDeletionDatabase(
          runtime,
          { ownerEntityId: SELF_ENTITY_ID, expectedSha256: inFlight.sha256 },
          async (tx) => {
            fenced = true;
            await fenceFamilyWorkspace(tx, runtime.agentId);
          },
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
      expect(fenced).toBe(false);
    } finally {
      release();
      storage.storePrivate = original;
    }
    const artifact = await uploading;
    expect(
      (
        await createAgreementKnowledgeService(runtime).readOwnerPdf({
          artifactId: artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        })
      ).bytes,
    ).toEqual(input.bytes);
    const pendingUpload = await beginAgreementUpload(runtime, {
      agreementKey: "pending-at-fence",
      title: "Pending",
      originalFilename: "pending.pdf",
      mimeType: "application/pdf",
      sizeBytes: input.bytes.length,
    });
    const readyUpload = await beginAgreementUpload(runtime, {
      agreementKey: "ready-at-fence",
      title: "Ready",
      originalFilename: "ready.pdf",
      mimeType: "application/pdf",
      sizeBytes: input.bytes.length,
    });
    const readyHash = crypto
      .createHash("sha256")
      .update(input.bytes)
      .digest("hex");
    await acceptAgreementChunk({
      runtime,
      uploadId: readyUpload.uploadId,
      index: 0,
      bytes: input.bytes,
      sha256: readyHash,
    });
    const readyIdentity = crypto
      .createHash("sha256")
      .update(
        [
          "agreement-upload-content-v1",
          String(input.bytes.length),
          String(readyUpload.chunkSizeBytes),
          `0:${input.bytes.length}:${readyHash}`,
        ].join("\n"),
      )
      .digest("hex");
    const service = createAgreementKnowledgeService(runtime);
    const proposed = await service.proposeObligation({
      artifactId: artifact.id,
      title: "Review before deletion",
      obligationText: "Preserve the recorded review decision.",
      pageStart: 1,
      citationText: "in-flight source before durable fence",
      proposedByEntityId: SELF_ENTITY_ID,
    });
    const pinned = await service.pin({
      artifactId: artifact.id,
      targetType: "agent",
      targetId: runtime.agentId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    const householdGrant = await household.issueGrant({
      principalEntityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const resourceGrant = await service.grantGuestRead({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
      householdGrantId: householdGrant.id,
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const taskInput = {
      kind: "recap" as const,
      promptInstructions: "Synthetic execution boundary check",
      trigger: { kind: "manual" as const },
      priority: "medium" as const,
      respectsGlobalPause: false,
      source: "plugin" as const,
      createdBy: runtime.agentId,
      ownerVisible: true,
      output: {
        destination: "channel" as const,
        target: "family_fence_test:local",
      },
    };
    const warningRepository = new HouseholdCoordinationRepository(
      runtime,
      runtime.agentId,
    );
    const warningGrant = await household.issueGrant({
      principalEntityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const warningTaskId = await warningRepository.getGrantExpiryWarningTaskId(
      warningGrant.id,
    );
    if (!warningTaskId) throw new Error("Real expiry warning was not linked");
    const familyTask = await runner.schedule({
      ...taskInput,
      metadata: { systemOperation: "family.monthlyCoordination" },
    });
    const unrelatedTask = await runner.schedule(taskInput);
    const settled = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(
      settled.records.filter((row) => row.kind === "workspaceOperations"),
    ).toEqual([]);
    await withReviewedFamilyDeletionDatabase(
      runtime,
      { ownerEntityId: SELF_ENTITY_ID, expectedSha256: settled.sha256 },
      (tx) => fenceFamilyWorkspace(tx, runtime.agentId),
    );
    const beforeReview = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    await expect(
      service.addOwnerReviewProposal({
        artifactId: artifact.id,
        ownerEntityId: SELF_ENTITY_ID,
        proposal: {
          title: "Late owner correction",
          obligationText: "in-flight source before durable fence",
          citationText: "in-flight source before durable fence",
          pageStart: 1,
          pageEnd: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    const reviewRepository = new AgreementKnowledgeRepository(
      runtime,
      runtime.agentId,
    );
    await expect(
      reviewRepository.commitPreparedReview(
        {
          artifactId: artifact.id,
          sourceSha256: artifact.contentSha256,
          extractionSha256: crypto
            .createHash("sha256")
            .update("Synthetic rejected review")
            .digest("hex"),
          generatedAt: new Date().toISOString(),
          explanation: "Review completed after deletion began",
          obligationIds: [],
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      service.proposeObligation({
        artifactId: artifact.id,
        title: "Too late",
        obligationText: "No new review work after deletion starts.",
        pageStart: 1,
        citationText: "in-flight source before durable fence",
        proposedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      service.decideObligation({
        obligationId: proposed.id,
        decision: "approve",
        decidedByEntityId: SELF_ENTITY_ID,
        reason: "Too late",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      service.pin({
        artifactId: artifact.id,
        targetType: "agent",
        targetId: runtime.agentId,
        pinnedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      service.unpin({
        pinId: pinned.id,
        unpinnedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      service.grantGuestRead({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
        householdGrantId: householdGrant.id,
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      service.revokeGuestRead({
        grantId: resourceGrant.id,
        revokedByEntityId: SELF_ENTITY_ID,
        reason: "Too late",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      household.issueGrant({
        principalEntityId: "verified-co-parent",
        role: "co_parent",
        subjectEntityIds: ["child-one"],
        scopes: ["knowledge.read"],
        issuedByEntityId: SELF_ENTITY_ID,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      household.revokeGrant({
        grantId: householdGrant.id,
        revokedByEntityId: SELF_ENTITY_ID,
        reason: "Too late",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    const mutationTime = "2098-12-31T00:00:00.000Z";
    await expect(
      warningRepository.markGrantExpiryWarningCancelled(
        warningGrant.id,
        mutationTime,
      ),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      warningRepository.completeGrantExpiryWarningClaim({
        grantId: warningGrant.id,
        attemptToken: "late-retry",
        scheduledTaskId: warningTaskId,
        warningAt: mutationTime,
        expiresAt: "2099-01-01T00:00:00.000Z",
        completedAt: mutationTime,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      warningRepository.releaseGrantExpiryWarningClaim({
        grantId: warningGrant.id,
        attemptToken: "late-retry",
        releasedAt: mutationTime,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      warningRepository.completeGrantExpiryWarningCancellation({
        grantId: warningGrant.id,
        completedAt: mutationTime,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      warningRepository.recordGrantExpiryWarningCancellationFailure({
        grantId: warningGrant.id,
        failedAt: mutationTime,
        error: "Synthetic delayed failure",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    expect(
      (await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID)).sha256,
    ).toBe(beforeReview.sha256);
    await expect(
      runner.fireWithResult(familyTask.taskId),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    expect(
      (await runner.list()).find((row) => row.taskId === familyTask.taskId)
        ?.state.status,
    ).toBe("scheduled");
    expect((await runner.fireWithResult(unrelatedTask.taskId)).kind).toBe(
      "fired",
    );
    const media = path.join(mediaStateDir, "media");
    const files = fs.readdirSync(media).sort();
    const documents = await executeRawSql(
      runtime,
      `SELECT id FROM memories WHERE agent_id=${sqlQuote(runtime.agentId)} AND type IN ('documents','document_fragments') ORDER BY id`,
    );
    // Reinitialization must preserve the durable fence rather than reopening it.
    await ensureFamilyWorkspaceOperationStore(runtime);
    await expect(
      beginAgreementUpload(runtime, {
        agreementKey: "after-fence",
        title: "After fence",
        originalFilename: "after.pdf",
        mimeType: "application/pdf",
        sizeBytes: input.bytes.length,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      acceptAgreementChunk({
        runtime,
        uploadId: pendingUpload.uploadId,
        index: 0,
        bytes: input.bytes,
        sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    let commitDispatched = false;
    await expect(
      commitAgreementUpload({
        runtime,
        uploadId: readyUpload.uploadId,
        contentIdentity: readyIdentity,
        createArtifact: async () => {
          commitDispatched = true;
          throw new Error("Commit must not dispatch after the fence");
        },
        readArtifact: async () => {
          throw new Error("Unexpected artifact read");
        },
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    expect(commitDispatched).toBe(false);
    expect(
      (await readAgreementUpload(runtime, readyUpload.uploadId)).status,
    ).toBe("uploading");
    await expect(
      createAgreementKnowledgeService(runtime).createAgreementVersion({
        ...input,
        agreementKey: "after-fence",
        bytes: pdf("must not be ingested after deletion begins"),
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    expect(fs.readdirSync(media).sort()).toEqual(files);
    expect(
      await executeRawSql(
        runtime,
        `SELECT id FROM memories WHERE agent_id=${sqlQuote(runtime.agentId)} AND type IN ('documents','document_fragments') ORDER BY id`,
      ),
    ).toEqual(documents);
  });
});

describe("reviewed workspace deletion — real database and disk", () => {
  it("authorizes owner HTTP deletion and exposes stale, pending, and retry states", async () => {
    const previousKmsBackend = process.env.ELIZA_KMS_BACKEND;
    process.env.ELIZA_KMS_BACKEND = "memory";
    const mediaDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "family-delete-http-"),
    );
    process.env.ELIZA_STATE_DIR = mediaDir;
    const result = await createLifeOpsTestRuntime({
      pgliteDir: path.join(mediaDir, "pglite"),
      plugins: [fileStoragePlugin, documentsPluginCore],
    });
    const runtime = result.runtime;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        url,
        pathname: url.pathname,
        method: req.method ?? "GET",
        runtime,
        isAuthorized: () => true,
      });
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    try {
      runtime.services.set(ServiceType.PDF, [
        new AgreementTestPdfService(runtime),
      ]);
      const graph = resolveKnowledgeGraphService(runtime);
      if (!graph) throw new Error("Real graph unavailable");
      await graph.getEntityStore(runtime.agentId).ensureSelf();
      await new CalendarCardAccessStore(runtime).ensureSchema();
      await new SchoolCalendarWorkflow(runtime).ensureSchema();
      await new MonthlyFamilyPacketService(runtime).list();
      const service = createAgreementKnowledgeService(runtime);
      const source = await service.createAgreementVersion({
        agreementKey: "http-delete",
        title: "HTTP deletion fixture",
        originalFilename: "http.pdf",
        mimeType: "application/pdf",
        bytes: pdf("HTTP deletion source"),
        uploadedByEntityId: SELF_ENTITY_ID,
      });
      const oldBackup = await createLocalAgentBackup(runtime, {});
      const db = (
        runtime as AgentRuntime & {
          adapter: { db: ConstructorParameters<typeof AuthStore>[0] };
        }
      ).adapter.db;
      const auth = new AuthStore(db);
      const ownerId = crypto.randomUUID();
      const guestId = crypto.randomUUID();
      for (const identity of [
        { id: ownerId, kind: "owner" as const },
        { id: guestId, kind: "machine" as const },
      ]) {
        await auth.createIdentity({
          ...identity,
          displayName: "Deletion fixture",
          createdAt: Date.now(),
          passwordHash: null,
          cloudUserId: null,
        });
      }
      const { session: owner } = await createBrowserSession(auth, {
        identityId: ownerId,
        ip: null,
        userAgent: null,
        rememberDevice: false,
      });
      const { session: guest } = await createMachineSession(auth, {
        identityId: guestId,
        scopes: [],
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP address");
      const base = `http://127.0.0.1:${address.port}/api/lifeops/family-workflows/deletion`;
      const headers = {
        Host: "deletion.example.test",
        "x-forwarded-for": "203.0.113.20",
        Authorization: `Bearer ${owner.id}`,
        "Content-Type": "application/json",
        // Physical snapshot work can outlast an idle keep-alive socket between requests.
        Connection: "close",
      };
      for (const [suffix, method] of [
        ["", "GET"],
        ["/preview", "GET"],
        ["", "POST"],
        ["/resume", "POST"],
        ["/backups/preview", "GET"],
        ["/backups", "POST"],
        ["/backups/resume", "POST"],
      ]) {
        const denied = await fetch(`${base}${suffix}`, {
          method,
          headers: {
            ...headers,
            Authorization: `Bearer ${guest.id}`,
            "x-eliza-entity-id": "self",
          },
        });
        expect(denied.status, await denied.text()).toBe(403);
      }
      const previewResponse = await fetch(`${base}/preview`, { headers });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      const stale = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedSha256: "0".repeat(64),
          backupRetention: "immediate",
        }),
      });
      expect(stale.status, await stale.clone().text()).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: "FAMILY_DELETION_PREVIEW_STALE",
      });
      const started = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedSha256: preview.sha256,
          backupRetention: "7-days",
        }),
      });
      expect(started.status, await started.clone().text()).toBe(202);
      const { job } = await started.json();
      expect(job.state).toBe("backup_pending");
      const status = await fetch(base, { headers });
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toEqual({ job });
      const resumed = await fetch(`${base}/resume`, {
        method: "POST",
        headers,
      });
      expect(resumed.status, await resumed.clone().text()).toBe(202);
      expect(await resumed.json()).toEqual({ job });
      const currentBackup = await createLocalAgentBackup(runtime, {});
      const currentBackupBytes = fs.readFileSync(currentBackup.path);
      const backupResponse = await fetch(`${base}/backups/preview`, {
        headers,
      });
      expect(backupResponse.status).toBe(200);
      expect(backupResponse.headers.get("cache-control")).toBe("no-store");
      const backupReview = await backupResponse.json();
      expect(
        backupReview.archives.map(
          (archive: { fileName: string }) => archive.fileName,
        ),
      ).toEqual([oldBackup.fileName]);
      const unacknowledged = await fetch(`${base}/backups`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedSha256: backupReview.sha256 }),
      });
      expect(unacknowledged.status).toBe(400);
      expect(fs.existsSync(oldBackup.path)).toBe(true);
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.state,
      ).toBe("backup_pending");
      await executeRawSql(
        runtime,
        "CREATE FUNCTION app_scheduling.reject_cleanup_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata_json::jsonb->>'systemOperation' = 'agent.familyBackupCleanup' THEN RAISE EXCEPTION 'schedule storage unavailable'; END IF; RETURN NEW; END; $$",
      );
      await executeRawSql(
        runtime,
        "CREATE TRIGGER reject_cleanup_schedule BEFORE INSERT ON app_scheduling.life_scheduled_tasks FOR EACH ROW EXECUTE FUNCTION app_scheduling.reject_cleanup_schedule()",
      );
      const scheduleInterrupted = await fetch(`${base}/backups`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedSha256: backupReview.sha256,
          acknowledgeWholeArchiveHistory: true,
        }),
      });
      expect(scheduleInterrupted.status).toBe(500);
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.backupCleanup
          ?.sha256,
      ).toBe(backupReview.sha256);
      expect(fs.existsSync(oldBackup.path)).toBe(true);
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_cleanup_schedule ON app_scheduling.life_scheduled_tasks",
      );
      await ensureFamilyBackupCleanupSchedule(runtime);
      const retained = await fetch(`${base}/backups`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedSha256: backupReview.sha256,
          acknowledgeWholeArchiveHistory: true,
        }),
      });
      expect(retained.status, await retained.clone().text()).toBe(202);
      await expect(
        purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID, {
          jobId: backupReview.jobId,
          sha256: backupReview.sha256,
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETENTION_PENDING" });
      expect(fs.existsSync(oldBackup.path)).toBe(true);
      await expect(
        purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID, {
          jobId: crypto.randomUUID(),
          sha256: backupReview.sha256,
        }),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_PREVIEW_STALE" });
      const afterRetention = Date.parse(backupReview.notBefore) + 1000;
      vi.spyOn(Date, "now").mockReturnValue(afterRetention);
      const { session: renewedOwner } = await createBrowserSession(auth, {
        identityId: ownerId,
        ip: null,
        userAgent: null,
        rememberDevice: false,
      });
      headers.Authorization = `Bearer ${renewedOwner.id}`;
      await executeRawSql(
        runtime,
        "CREATE FUNCTION app_lifeops.reject_backup_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_json->>'state' = 'complete' THEN RAISE EXCEPTION 'completion storage unavailable'; END IF; RETURN NEW; END; $$",
      );
      await executeRawSql(
        runtime,
        "CREATE TRIGGER reject_backup_completion BEFORE UPDATE ON app_lifeops.life_family_workspace_deletions FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_backup_completion()",
      );
      const interrupted = await fetch(`${base}/backups`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedSha256: backupReview.sha256,
          acknowledgeWholeArchiveHistory: true,
        }),
      });
      expect(interrupted.status).toBe(500);
      expect(fs.existsSync(oldBackup.path)).toBe(false);
      expect(fs.readFileSync(currentBackup.path)).toEqual(currentBackupBytes);
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.state,
      ).toBe("backup_pending");
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_backup_completion ON app_lifeops.life_family_workspace_deletions",
      );
      await ensureFamilyBackupCleanupSchedule(runtime);
      await ensureFamilyBackupCleanupSchedule(runtime);
      const runner = getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
        now: () => new Date(afterRetention),
      });
      const cleanupTasks = (await runner.list()).filter(
        (task) =>
          task.metadata?.systemOperation === FAMILY_BACKUP_CLEANUP_OPERATION,
      );
      expect(cleanupTasks).toHaveLength(1);
      const cleanupTask = cleanupTasks[0];
      if (!cleanupTask) throw new Error("Admitted cleanup was not scheduled");
      expect((await runner.fireWithResult(cleanupTask.taskId)).kind).toBe(
        "fired",
      );
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.state,
      ).toBe("complete");
      const completed = await fetch(`${base}/backups/resume`, {
        method: "POST",
        headers,
      });
      expect(completed.status, await completed.clone().text()).toBe(200);
      const complete = await completed.json();
      expect(complete.job.state).toBe("complete");
      const replay = await fetch(`${base}/backups/resume`, {
        method: "POST",
        headers,
      });
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.json()).toEqual(complete);
      expect(fs.readFileSync(currentBackup.path)).toEqual(currentBackupBytes);
      const storage = runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      if (!storage) throw new Error("Missing real file storage");
      expect(await storage.readPrivate(source.mediaFileName)).toBeNull();
      await expect(
        service.readOwnerPdf({
          artifactId: source.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    } finally {
      vi.restoreAllMocks();
      if (previousKmsBackend === undefined)
        delete process.env.ELIZA_KMS_BACKEND;
      else process.env.ELIZA_KMS_BACKEND = previousKmsBackend;
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await result.cleanup();
      delete process.env.ELIZA_STATE_DIR;
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
  });

  it("atomically removes private database projections and journals remaining files", async () => {
    const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-delete-"));
    process.env.ELIZA_STATE_DIR = mediaDir;
    const result = await createLifeOpsTestRuntime({
      plugins: [fileStoragePlugin, documentsPluginCore],
    });
    const runtime = result.runtime;
    try {
      runtime.services.set(ServiceType.PDF, [
        new AgreementTestPdfService(runtime),
      ]);
      const graph = resolveKnowledgeGraphService(runtime);
      if (!graph) throw new Error("Real graph unavailable");
      await graph.getEntityStore(runtime.agentId).ensureSelf();
      await new CalendarCardAccessStore(runtime).ensureSchema();
      await new SchoolCalendarWorkflow(runtime).ensureSchema();
      await new MonthlyFamilyPacketService(runtime).list();
      const service = createAgreementKnowledgeService(runtime);
      const bytes = pdf("synthetic source to delete");
      const first = await service.createAgreementVersion({
        agreementKey: "delete-atomic",
        title: "Delete atomic",
        originalFilename: "atomic.pdf",
        mimeType: "application/pdf",
        bytes,
        uploadedByEntityId: SELF_ENTITY_ID,
      });
      const storage = runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      const documents = runtime.getService<DocumentService>(
        DocumentService.serviceType,
      );
      if (!storage || !documents)
        throw new Error("Real document and file services required");
      const context = {
        requesterEntityId: runtime.agentId,
        role: "OWNER" as const,
      };
      expect(
        await documents.getDocumentByIdWithAccessContext(
          first.documentId as UUID,
          context,
        ),
      ).not.toBeNull();
      const foreignId = `hag_${crypto.randomUUID()}`;
      await executeRawSql(
        runtime,
        `INSERT INTO app_lifeops.life_household_agreement_artifacts SELECT (jsonb_populate_record(NULL::app_lifeops.life_household_agreement_artifacts, to_jsonb(source) || ${sqlQuote(JSON.stringify({ id: foreignId, agent_id: "foreign-workspace" }))}::jsonb)).* FROM app_lifeops.life_household_agreement_artifacts source WHERE id=${sqlQuote(first.id)}`,
      );
      const preview = await previewFamilyDeletionDatabase(
        runtime,
        SELF_ENTITY_ID,
      );
      expect(preview.unavailable).toEqual([]);
      await expect(
        beginFamilyWorkspaceDeletion(runtime, {
          ownerEntityId: "guest",
          expectedSha256: preview.sha256,
          backupRetention: "immediate",
        }),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_ACCESS_DENIED" });
      await expect(
        beginFamilyWorkspaceDeletion(runtime, {
          ownerEntityId: SELF_ENTITY_ID,
          expectedSha256: preview.sha256,
          backupRetention: "immediate",
        }),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_SHARED_SOURCE" });
      const foreignBytes = pdf("independent foreign source");
      const foreignFile = await storage.storePrivate(
        foreignBytes,
        "application/pdf",
      );
      await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_household_agreement_artifacts SET media_file_name=${sqlQuote(foreignFile.fileName)}, document_id=${sqlQuote(crypto.randomUUID())}, content_sha256=${sqlQuote(crypto.createHash("sha256").update(foreignBytes).digest("hex"))} WHERE id=${sqlQuote(foreignId)}`,
      );
      await readFamilyDeletionJob(runtime, SELF_ENTITY_ID);
      await executeRawSql(
        runtime,
        `CREATE FUNCTION app_lifeops.reject_delete_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'journal storage unavailable'; END; $$`,
      );
      await executeRawSql(
        runtime,
        `CREATE TRIGGER reject_delete_journal BEFORE INSERT ON app_lifeops.life_family_workspace_deletions FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_delete_journal()`,
      );
      await expect(
        beginFamilyWorkspaceDeletion(runtime, {
          ownerEntityId: SELF_ENTITY_ID,
          expectedSha256: preview.sha256,
          backupRetention: "immediate",
        }),
      ).rejects.toMatchObject({
        code: "FAMILY_DELETION_TRANSACTION_FAILED",
        cause: { cause: { message: "journal storage unavailable" } },
      });
      expect(
        (
          await service.readOwnerPdf({
            artifactId: first.id,
            ownerEntityId: SELF_ENTITY_ID,
          })
        ).bytes,
      ).toEqual(bytes);
      expect(
        await documents.getDocumentByIdWithAccessContext(
          first.documentId as UUID,
          context,
        ),
      ).not.toBeNull();
      expect(await readFamilyDeletionJob(runtime, SELF_ENTITY_ID)).toBeNull();
      await expect(
        withAgentBackupAuthority(mediaDir, (authority) =>
          authority.generation(runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETIREMENT_PENDING" });
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_delete_journal ON app_lifeops.life_family_workspace_deletions",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_delete_journal()",
      );
      const job = await beginFamilyWorkspaceDeletion(runtime, {
        ownerEntityId: SELF_ENTITY_ID,
        expectedSha256: preview.sha256,
        backupRetention: "immediate",
      });
      expect(job.files).toContainEqual({
        fileName: first.mediaFileName,
        sha256: first.contentSha256,
      });
      expect(await readFamilyDeletionJob(runtime, SELF_ENTITY_ID)).toEqual(job);
      expect(
        await beginFamilyWorkspaceDeletion(runtime, {
          ownerEntityId: SELF_ENTITY_ID,
          expectedSha256: preview.sha256,
          backupRetention: "immediate",
        }),
      ).toEqual(job);
      expect(
        await withAgentBackupAuthority(mediaDir, (authority) =>
          authority.pendingRetirement(runtime.agentId),
        ),
      ).toEqual({
        operationId: job.backupOperationId,
        generation: job.backupGeneration,
      });
      expect(
        await documents.getDocumentByIdWithAccessContext(
          first.documentId as UUID,
          context,
        ),
      ).toBeNull();
      expect(
        await executeRawSql(
          runtime,
          `SELECT id FROM app_lifeops.life_household_agreement_artifacts WHERE agent_id=${sqlQuote(runtime.agentId)}`,
        ),
      ).toEqual([]);
      expect(
        await executeRawSql(
          runtime,
          `SELECT id FROM app_lifeops.life_household_agreement_artifacts WHERE id=${sqlQuote(foreignId)}`,
        ),
      ).toEqual([{ id: foreignId }]);
      expect(await storage.readPrivate(first.mediaFileName)).toEqual(bytes);
      await expect(
        service.readOwnerPdf({
          artifactId: first.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
      const originalDelete = storage.deletePrivate.bind(storage);
      const privatePath = path.join(mediaDir, "media", first.mediaFileName);
      const changedBytes = Buffer.alloc(bytes.length, 0);
      try {
        fs.writeFileSync(privatePath, changedBytes);
        await expect(
          purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID),
        ).rejects.toMatchObject({ code: "FAMILY_DELETION_FILE_CHANGED" });
        expect(fs.readFileSync(privatePath)).toEqual(changedBytes);
        expect(await readFamilyDeletionJob(runtime, SELF_ENTITY_ID)).toEqual(
          job,
        );
      } finally {
        fs.writeFileSync(privatePath, bytes);
      }
      storage.deletePrivate = async () => true;
      try {
        await expect(
          purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID),
        ).rejects.toMatchObject({ code: "FAMILY_DELETION_FILE_PURGE_FAILED" });
        expect(await storage.readPrivate(first.mediaFileName)).toEqual(bytes);
        expect(await readFamilyDeletionJob(runtime, SELF_ENTITY_ID)).toEqual(
          job,
        );
      } finally {
        storage.deletePrivate = originalDelete;
      }
      storage.deletePrivate = async (fileName) => {
        await originalDelete(fileName);
        throw new Error("Lost private-delete acknowledgement");
      };
      try {
        await expect(
          purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID),
        ).rejects.toMatchObject({ code: "FAMILY_DELETION_FILE_PURGE_FAILED" });
      } finally {
        storage.deletePrivate = originalDelete;
      }
      expect(await storage.readPrivate(first.mediaFileName)).toBeNull();
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.state,
      ).toBe("purge_pending");
      await expect(
        withAgentBackupAuthority(mediaDir, (authority) =>
          authority.generation(runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RETIREMENT_PENDING" });
      const cleaned = await purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID);
      expect(cleaned.state).toBe("backup_pending");
      expect(
        await withAgentBackupAuthority(mediaDir, (authority) =>
          authority.generation(runtime.agentId),
        ),
      ).toBe(job.backupGeneration);
      expect(await purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID)).toEqual(
        cleaned,
      );
      expect(await storage.readPrivate(foreignFile.fileName)).toEqual(
        foreignBytes,
      );
      await expect(
        previewFamilyBackupCleanup(runtime, "guest"),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_ACCESS_DENIED" });
      await expect(
        purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID),
      ).rejects.toMatchObject({
        code: "FAMILY_DELETION_BACKUP_REVIEW_REQUIRED",
      });
      const backupReview = await previewFamilyBackupCleanup(
        runtime,
        SELF_ENTITY_ID,
      );
      await executeRawSql(
        runtime,
        "CREATE FUNCTION app_lifeops.reject_backup_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'backup admission unavailable'; END; $$",
      );
      await executeRawSql(
        runtime,
        "CREATE TRIGGER reject_backup_admission BEFORE UPDATE ON app_lifeops.life_family_workspace_deletions FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_backup_admission()",
      );
      await expect(
        admitFamilyBackupCleanup(runtime, {
          ownerEntityId: SELF_ENTITY_ID,
          expectedSha256: backupReview.sha256,
          acknowledgeWholeArchiveHistory: true,
        }),
      ).rejects.toThrow();
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.backupCleanup,
      ).toBeUndefined();
      await expect(
        purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID),
      ).rejects.toMatchObject({
        code: "FAMILY_DELETION_BACKUP_REVIEW_REQUIRED",
      });
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_backup_admission ON app_lifeops.life_family_workspace_deletions",
      );
      const admission = await admitFamilyBackupCleanup(runtime, {
        ownerEntityId: SELF_ENTITY_ID,
        expectedSha256: backupReview.sha256,
        acknowledgeWholeArchiveHistory: true,
      });
      expect(
        (await readFamilyDeletionJob(runtime, SELF_ENTITY_ID))?.backupCleanup,
      ).toEqual(admission.backupCleanup);
      const complete = await purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID);
      expect(complete.state).toBe("complete");
      expect(await purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID)).toEqual(
        complete,
      );
      expect(
        await executeRawSql(
          runtime,
          `SELECT state FROM app_lifeops.life_family_workspace_state WHERE agent_id=${sqlQuote(runtime.agentId)}`,
        ),
      ).toEqual([{ state: "deleted" }]);
      expect(await storage.readPrivate(foreignFile.fileName)).toEqual(
        foreignBytes,
      );
    } finally {
      await result.cleanup();
      delete process.env.ELIZA_STATE_DIR;
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
  });
});
