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
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { bindMachineAuthIdentityToEntity } from "../../routes/authenticated-entity-principal.js";
import { MonthlyFamilyPacketService } from "../family-coordination/monthly-packet.js";
import { exportFamilyWorkspace } from "../family-workflows/workspace-export.js";
import {
  CONCORD_SCHOOL_CALENDAR_SOURCE,
  SchoolCalendarWorkflow,
} from "../school/calendar-workflow.js";
import { executeRawSql, sqlQuote } from "../sql.js";
import {
  AgreementKnowledgeError,
  AgreementKnowledgeRepository,
  AgreementKnowledgeService,
  createAgreementKnowledgeService,
  type ParentingAgreementArtifact,
} from "./agreement-knowledge.js";
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
    }
  });
});
