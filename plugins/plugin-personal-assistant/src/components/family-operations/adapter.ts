/** Production Family Operations adapter over owner-authorized local APIs. */

import { client } from "@elizaos/ui/api";
import type {
  MonthlyFamilyDraft,
  MonthlyFamilyPacket,
} from "../../lifeops/family-coordination/index.js";
import type {
  FamilyDraftApprovalStatus,
  FamilyEmailOptions,
  FamilySchoolWorkflowStatus,
} from "../../lifeops/family-workflows/runtime.js";
import type { ParentingAgreementView } from "../../lifeops/household/agreement-knowledge.js";
import type { SchoolCalendarRunReview } from "../../lifeops/school/calendar-workflow.js";
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
  FamilyPacketView,
  LinkedCalendarView,
  Loadable,
  SchoolWorkflowView,
} from "./types.js";

interface PacketPersistenceState {
  packetId: string;
  internalVersion: number;
  draft: MonthlyFamilyDraft | null;
  approvalId: string | null;
  approval: FamilyDraftApprovalStatus | null;
}

interface AgreementUploadState {
  uploadId: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  receivedChunks: Array<{ index: number; size: number; sha256: string }>;
  receivedBytes: number;
  status: "uploading" | "committing" | "complete";
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function agreementContentIdentity(input: {
  sizeBytes: number;
  chunkSizeBytes: number;
  chunks: Array<{ index: number; size: number; sha256: string }>;
}): Promise<string> {
  const canonical = [
    "agreement-upload-content-v1",
    String(input.sizeBytes),
    String(input.chunkSizeBytes),
    ...[...input.chunks]
      .sort((left, right) => left.index - right.index)
      .map((chunk) => `${chunk.index}:${chunk.size}:${chunk.sha256}`),
  ].join("\n");
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await client.rawRequest(
    path,
    {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    },
    {
      allowNonOk: true,
      // A workflow's accepted mutation is terminal for this request; polling
      // it as agent startup could repeat the owner-authorized operation.
      skipResume: true,
      // PDF extraction and school discovery can include model work. Keep
      // those mutations on the same ten-minute budget as a model-backed turn.
      timeoutMs:
        init?.method && init.method !== "GET" ? 10 * 60_000 : undefined,
    },
  );
  const payload = (await response.json()) as {
    error?: { message?: string } | string;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return payload as T;
}

async function loadSection<T>(path: string, key: string): Promise<Loadable<T>> {
  try {
    const payload = await request<Record<string, T>>(path);
    return { status: "ready", data: payload[key] as T };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Service unavailable",
    };
  }
}

function schoolView(
  status: FamilySchoolWorkflowStatus,
  review: SchoolCalendarRunReview | null,
): SchoolWorkflowView {
  const state = status.lastRun?.state ?? "never_run";
  return {
    monthlySchedule: Object.hasOwn(status, "monthlySchedule")
      ? { status: "ready", data: status.monthlySchedule }
      : {
          status: "unavailable",
          message:
            "The connected runtime does not report its saved family schedule. Update the runtime to verify it.",
        },
    sourceId: status.sourceId,
    label: "Concord Public Schools calendar",
    state:
      state === "running" ||
      state === "unchanged" ||
      state === "awaiting_approval" ||
      state === "applied" ||
      state === "failed"
        ? state
        : "never_run",
    lastCheckedAt: status.lastRun?.updatedAt ?? null,
    sourceUrl: status.config?.landingPageUrl ?? "",
    schoolLevel: status.config?.schoolLevel ?? "all",
    updateMode: status.config?.updateMode ?? "review",
    runId: status.lastRun?.runId,
    changes: review?.plan?.changes.flatMap((change) =>
      change.kind === "unchanged"
        ? []
        : [
            {
              kind: change.kind === "cancel" ? "remove" : change.kind,
              label: change.event.title,
            },
          ],
    ),
    error: review?.errorMessage ?? undefined,
  };
}

function packetView(
  packet: MonthlyFamilyPacket,
  persistence?: PacketPersistenceState,
): FamilyPacketView {
  const states = packet.sections.map((section) => section.state);
  return {
    packetId: packet.packetId,
    periodKey: packet.period.key,
    version: packet.version,
    createdAt: packet.createdAt,
    status: states.includes("contradictory")
      ? "contradictory"
      : states.includes("missing")
        ? "missing"
        : "complete",
    sections: packet.sections,
    claims: packet.claims.map((claim) => ({
      id: claim.claimId,
      section: claim.section,
      text: claim.statement,
    })),
    draft:
      persistence?.draft?.internalVersion === packet.version
        ? {
            draftVersion: persistence.draft.draftVersion,
            recipient: persistence.draft.recipient,
            recipientEntityId: persistence.draft.recipientEntityId,
            calendarPrivacyMode: persistence.draft.calendarPrivacyMode,
            body: persistence.draft.body,
            bodySha256: persistence.draft.bodySha256,
            approval: persistence.approval,
            email: persistence.draft.email,
            approvalId: persistence.approvalId ?? undefined,
          }
        : null,
  };
}

async function loadSchool(): Promise<Loadable<SchoolWorkflowView>> {
  try {
    const status = await request<FamilySchoolWorkflowStatus>(
      "/api/lifeops/family-workflows/school/status",
    );
    const review = status.lastRun?.runId
      ? await request<SchoolCalendarRunReview>(
          `/api/lifeops/family-workflows/school/runs/${encodeURIComponent(status.lastRun.runId)}`,
        )
      : null;
    return { status: "ready", data: schoolView(status, review) };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Service unavailable",
    };
  }
}

async function loadPackets(): Promise<Loadable<FamilyPacketView[]>> {
  try {
    const payload = await request<{
      packets: MonthlyFamilyPacket[];
      packetStates?: PacketPersistenceState[];
    }>("/api/lifeops/family-workflows/packets");
    const states = new Map(
      (payload.packetStates ?? []).map((state) => [
        JSON.stringify([state.packetId, state.internalVersion]),
        state,
      ]),
    );
    return {
      status: "ready",
      data: payload.packets.map((packet) =>
        packetView(
          packet,
          states.get(JSON.stringify([packet.packetId, packet.version])),
        ),
      ),
    };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Service unavailable",
    };
  }
}

async function downloadFile(
  path: string,
  method: "GET" | "POST",
): Promise<Blob> {
  const response = await client.rawRequest(
    path,
    { method },
    {
      allowNonOk: true,
      skipResume: true,
      timeoutMs: 10 * 60_000,
    },
  );
  if (!response.ok) {
    const failureMessage = `Download failed (${response.status})`;
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
      throw new Error(failureMessage);
    }
    const payload = await response.json().catch((cause) => {
      // error-policy:J1 Invalid proxy error bodies retain the HTTP failure.
      throw new Error(failureMessage, { cause });
    });
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message;
    throw new Error(typeof message === "string" ? message : failureMessage);
  }
  return response.blob();
}

export const defaultFamilyOperationsAdapter: FamilyOperationsAdapter = {
  async decidePacketApproval(input) {
    const response = await request<{
      result: { success?: boolean; text?: string };
    }>(
      `/api/lifeops/family-workflows/packets/${encodeURIComponent(input.packetId)}/drafts/${input.draftVersion}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvalId: input.approvalId,
          bodySha256: input.bodySha256,
          decision: input.decision,
        }),
      },
    );
    if (response.result.success !== true)
      throw new Error(
        response.result.text ||
          "Approval did not complete. Check the saved delivery status.",
      );
  },
  async listRecipientContacts() {
    const result = await request<{
      entities: Array<{ entityId: string; preferredName: string }>;
    }>("/api/lifeops/entities?type=person");
    return result.entities.map((person) => ({
      entityId: person.entityId,
      name: person.preferredName,
    }));
  },
  async confirmEmailRecipient(input) {
    const result = await request<{
      recipient: { entityId: string; name: string; address: string };
    }>("/api/lifeops/family-workflows/email-recipients/confirm", {
      method: "POST",
      body: JSON.stringify({ ...input, confirmed: true }),
    });
    return result.recipient;
  },

  async load(): Promise<FamilyOperationsSnapshot> {
    const [agreements, calendarLinks, school, packets, emailOptions] =
      await Promise.all([
        loadSection<ParentingAgreementView[]>(
          "/api/lifeops/agreements",
          "agreements",
        ),
        loadSection<LinkedCalendarView[]>(
          "/api/lifeops/calendar/links?view=events",
          "links",
        ),
        loadSchool(),
        loadPackets(),
        loadSection<FamilyEmailOptions>(
          "/api/lifeops/family-workflows/email-options",
          "options",
        ),
      ]);
    return { agreements, calendarLinks, school, packets, emailOptions };
  },
  async downloadAgreement(artifactId, format) {
    return downloadFile(
      `/api/lifeops/agreements/${encodeURIComponent(artifactId)}/${format === "export" ? "export" : "download"}`,
      format === "export" ? "POST" : "GET",
    );
  },
  async downloadWorkspace() {
    const blob = await downloadFile(
      "/api/lifeops/family-workflows/export",
      "POST",
    );
    if (blob.type !== "application/zip")
      throw new Error("The server did not return a workspace archive.");
    return blob;
  },

  async uploadAgreement(input) {
    if (input.file.type !== "application/pdf") {
      throw new Error("Agreement must be a PDF.");
    }
    if (input.file.size < 1) {
      throw new Error("Agreement PDF must not be empty.");
    }
    const signature = new Uint8Array(
      await input.file.slice(0, 5).arrayBuffer(),
    );
    if (new TextDecoder("ascii").decode(signature) !== "%PDF-") {
      throw new Error("Agreement PDF signature is invalid.");
    }

    const resumeKey = `lifeops:agreement-upload:${input.file.name}:${input.file.size}:${input.file.lastModified}:${input.agreementKey}:${input.title}`;
    let upload: AgreementUploadState | null = null;
    const savedUploadId = sessionStorage.getItem(resumeKey);
    if (savedUploadId) {
      try {
        const response = await request<{ upload: AgreementUploadState }>(
          `/api/lifeops/agreement-uploads/${encodeURIComponent(savedUploadId)}`,
        );
        upload = response.upload;
      } catch {
        sessionStorage.removeItem(resumeKey);
      }
    }
    if (!upload) {
      const response = await request<{ upload: AgreementUploadState }>(
        "/api/lifeops/agreement-uploads",
        {
          method: "POST",
          body: JSON.stringify({
            agreementKey: input.agreementKey,
            title: input.title,
            originalFilename: input.file.name,
            mimeType: input.file.type,
            sizeBytes: input.file.size,
          }),
        },
      );
      upload = response.upload;
      sessionStorage.setItem(resumeKey, upload.uploadId);
    }

    if (upload.status === "complete") {
      sessionStorage.removeItem(resumeKey);
      return;
    }

    const received = new Map(
      upload.receivedChunks.map((chunk) => [chunk.index, chunk]),
    );
    const verifiedChunks: Array<{
      index: number;
      size: number;
      sha256: string;
    }> = [];
    let uploadedBytes = 0;
    input.onProgress?.({
      uploadedBytes,
      totalBytes: input.file.size,
      phase: "uploading",
    });
    for (let index = 0; index < upload.chunkCount; index += 1) {
      const start = index * upload.chunkSizeBytes;
      const end = Math.min(start + upload.chunkSizeBytes, input.file.size);
      const bytes = await input.file.slice(start, end).arrayBuffer();
      const sha256 = await sha256Hex(bytes);
      const recorded = received.get(index);
      if (recorded) {
        if (recorded.size !== bytes.byteLength || recorded.sha256 !== sha256) {
          sessionStorage.removeItem(resumeKey);
          throw new Error(
            "The selected PDF no longer matches the resumable upload. Retry to start a new verified upload.",
          );
        }
      } else {
        await request<{ upload: AgreementUploadState }>(
          `/api/lifeops/agreement-uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "x-chunk-sha256": sha256,
            },
            body: bytes,
          },
        );
      }
      verifiedChunks.push({ index, size: bytes.byteLength, sha256 });
      uploadedBytes += bytes.byteLength;
      input.onProgress?.({
        uploadedBytes,
        totalBytes: input.file.size,
        phase: "uploading",
      });
    }
    input.onProgress?.({
      uploadedBytes: input.file.size,
      totalBytes: input.file.size,
      phase: "processing",
    });
    const contentIdentity = await agreementContentIdentity({
      sizeBytes: input.file.size,
      chunkSizeBytes: upload.chunkSizeBytes,
      chunks: verifiedChunks,
    });
    await request(
      `/api/lifeops/agreement-uploads/${encodeURIComponent(upload.uploadId)}/commit`,
      { method: "POST", body: JSON.stringify({ contentIdentity }) },
    );
    sessionStorage.removeItem(resumeKey);
  },
  async readAgreementReview(artifactId) {
    const response = await request<{
      review: Awaited<
        ReturnType<FamilyOperationsAdapter["readAgreementReview"]>
      >;
    }>(`/api/lifeops/agreements/${encodeURIComponent(artifactId)}/review`);
    return response.review;
  },
  async prepareAgreementReview(artifactId) {
    const response = await request<{
      review: Awaited<
        ReturnType<FamilyOperationsAdapter["prepareAgreementReview"]>
      >;
    }>(`/api/lifeops/agreements/${encodeURIComponent(artifactId)}/review`, {
      method: "POST",
    });
    return response.review;
  },
  async addAgreementProposal(artifactId, proposal) {
    return request<
      Awaited<ReturnType<FamilyOperationsAdapter["addAgreementProposal"]>>
    >(`/api/lifeops/agreements/${encodeURIComponent(artifactId)}/obligations`, {
      method: "POST",
      body: JSON.stringify(proposal),
    });
  },
  async decideObligation(obligation, decision, reason) {
    const response = await request<{ obligation: typeof obligation }>(
      `/api/lifeops/agreements/obligations/${encodeURIComponent(obligation.id)}/decision`,
      { method: "POST", body: JSON.stringify({ decision, reason }) },
    );
    return response.obligation;
  },
  async listPinTargets() {
    return request<
      Awaited<ReturnType<FamilyOperationsAdapter["listPinTargets"]>>
    >("/api/lifeops/agreements/pin-targets");
  },
  async listPins(artifactId) {
    const response = await request<{
      pins: Awaited<ReturnType<FamilyOperationsAdapter["listPins"]>>;
    }>(`/api/lifeops/agreements/${encodeURIComponent(artifactId)}/pins`);
    return response.pins;
  },
  async pin(input) {
    const response = await request<{
      pin: Awaited<ReturnType<FamilyOperationsAdapter["pin"]>>;
    }>(`/api/lifeops/agreements/${encodeURIComponent(input.artifactId)}/pins`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.pin;
  },
  async unpin(pinId) {
    const response = await request<{
      pin: Awaited<ReturnType<FamilyOperationsAdapter["unpin"]>>;
    }>(`/api/lifeops/agreements/pins/${encodeURIComponent(pinId)}`, {
      method: "DELETE",
    });
    return response.pin;
  },
  async listGuestAccessOptions(artifactId) {
    return request<
      Awaited<ReturnType<FamilyOperationsAdapter["listGuestAccessOptions"]>>
    >(
      `/api/lifeops/agreements/${encodeURIComponent(artifactId)}/guest-options`,
    );
  },
  async previewGrant(input) {
    const response = await request<{
      preview: Awaited<ReturnType<FamilyOperationsAdapter["previewGrant"]>>;
    }>("/api/lifeops/agreements/grants/preview", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.preview;
  },
  async issueGrant(input) {
    const response = await request<{
      grant: Awaited<ReturnType<FamilyOperationsAdapter["issueGrant"]>>;
    }>("/api/lifeops/agreements/grants", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.grant;
  },
  async revokeGrant(grantId, reason) {
    const response = await request<{
      grant: Awaited<ReturnType<FamilyOperationsAdapter["revokeGrant"]>>;
    }>(`/api/lifeops/agreements/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    return response.grant;
  },
  async resolveCalendarConflict(linkId, resolution, expectedUpdatedAt) {
    await request(
      `/api/lifeops/calendar/links/${encodeURIComponent(linkId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          strategy: resolution,
          expectedUpdatedAt,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
  },
  async disconnectCalendar(linkId, expectedUpdatedAt) {
    await request(
      `/api/lifeops/calendar/links/${encodeURIComponent(linkId)}/disconnect`,
      {
        method: "POST",
        body: JSON.stringify({
          retainEvents: true,
          expectedUpdatedAt,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
  },
  async runSchoolWorkflow() {
    await request("/api/lifeops/family-workflows/school/run", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  async configureSchool(input) {
    await request("/api/lifeops/family-workflows/school/source", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  async updateMonthlySchedule({ taskId, day, time, timezone }) {
    if (
      !Number.isInteger(day) ||
      day < 1 ||
      day > 31 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    ) {
      throw new Error("Choose a day from 1 to 31 and a valid time.");
    }
    const [hour, minute] = time.split(":").map(Number);
    await request(
      `/api/lifeops/scheduled-tasks/${encodeURIComponent(taskId)}/edit`,
      {
        method: "POST",
        body: JSON.stringify({
          trigger: {
            kind: "cron",
            expression: `${minute} ${hour} ${day} * *`,
            tz: timezone,
          },
        }),
      },
    );
  },
  async approveSchoolDiff(runId) {
    await request("/api/lifeops/family-workflows/school/apply", {
      method: "POST",
      body: JSON.stringify({ runId }),
    });
  },
  async generatePacket(periodKey) {
    await request("/api/lifeops/family-workflows/packets", {
      method: "POST",
      body: JSON.stringify({ periodKey }),
    });
  },
  async createPacketDraft(input) {
    await request(
      `/api/lifeops/family-workflows/packets/${encodeURIComponent(input.packetId)}/drafts`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedPacketVersion: input.expectedPacketVersion,
          recipient: input.recipient,
          recipientEntityId: input.recipientEntityId,
          calendarPrivacyMode: input.calendarPrivacyMode,
          ...(input.email ? { email: input.email } : {}),
        }),
      },
    );
  },
  async revisePacketDraft(input) {
    await request(
      `/api/lifeops/family-workflows/packets/${encodeURIComponent(input.packetId)}/drafts/${input.expectedDraftVersion}/revision`,
      {
        method: "POST",
        body: JSON.stringify({ body: input.body, subject: input.subject }),
      },
    );
  },
  async requestPacketApproval(packetId, draftVersion) {
    await request(
      `/api/lifeops/family-workflows/packets/${encodeURIComponent(packetId)}/drafts/${draftVersion}/approval`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
};

export { request as familyOperationsRequest };
