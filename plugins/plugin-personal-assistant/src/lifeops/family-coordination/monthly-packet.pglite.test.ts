/**
 * Real-PGlite integration coverage for monthly family packet persistence,
 * provenance, contradictions, one-time carry-forward, privacy, expense
 * exclusion, and immutable canonical-approval binding.
 */

import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalEnqueueInput,
  ApprovalRequest,
} from "../approval-queue.types.js";
import { collectCalendarClaims } from "../family-workflows/calendar-claims.js";
import {
  ensureFamilyWorkspaceOperationStore,
  fenceFamilyWorkspace,
} from "../family-workflows/workspace-operation-store.js";
import { type RawSqlQuery, withRequiredTransaction } from "../sql.js";
import { familyIntakeClaim } from "./intake-claims.js";

import { FamilyIntakeReviewStore } from "./intake-review.js";
import { getFamilyIntakeService } from "./intake-service.js";
import {
  type FamilyPacketClaim,
  type FamilyPacketPeriod,
  MonthlyFamilyPacketService,
} from "./monthly-packet.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function period(key: string): FamilyPacketPeriod {
  const [year, month] = key.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return {
    key,
    startsOn: `${key}-01`,
    endsOnExclusive: next.toISOString().slice(0, 10),
    timeZone: "America/New_York",
  };
}

function claim(
  id: string,
  overrides: Partial<FamilyPacketClaim> = {},
): FamilyPacketClaim {
  return {
    claimId: id,
    stableKey: id,
    section: "custody_calendar",
    statement: `Statement ${id}`,
    visibility: "guest_shareable",
    provenance: [
      {
        source: "calendar",
        sourceId: `source-${id}`,
        observedAt: "2026-08-30T12:00:00.000Z",
        contentSha256: digest(id),
      },
    ],
    dates: ["2026-09-03"],
    requests: [],
    urgency: null,
    commitments: [],
    accountability: [],
    recipientEntityIds: ["guest-1"],
    ...overrides,
  };
}

const guestDraft = {
  recipient: "guest@example.com",
  recipientEntityId: "guest-1",
  calendarPrivacyMode: "full" as const,
};

function approval(
  input: ApprovalEnqueueInput,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id: "approval-1",
    createdAt: new Date("2026-08-30T12:00:00.000Z"),
    updatedAt: new Date("2026-08-30T12:00:00.000Z"),
    state: "pending",
    requestedBy: input.requestedBy,
    subjectUserId: input.subjectUserId,
    action: input.action,
    payload: input.payload,
    channel: input.channel,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey ?? null,
    expiresAt: input.expiresAt,
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    execution: null,
    ...overrides,
  };
}

describe("MonthlyFamilyPacketService with real PGlite", () => {
  let db: PGlite;
  let runtime: IAgentRuntime;
  let service: MonthlyFamilyPacketService;
  let beforeNextTransaction: (() => Promise<void>) | null;

  beforeEach(async () => {
    db = await PGlite.create();
    beforeNextTransaction = null;
    runtime = {
      agentId: "agent-a",
      getService: () => null,
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
          transaction: async <T>(
            fn: (tx: {
              execute: (query: RawSqlQuery) => Promise<unknown>;
            }) => Promise<T> | T,
          ) => {
            const barrier = beforeNextTransaction;
            beforeNextTransaction = null;
            if (barrier) await barrier();
            return db.transaction(async (transaction) =>
              fn({
                execute: async (query) =>
                  transaction.query(
                    query.queryChunks
                      .map((chunk) => chunk.value ?? "")
                      .join(""),
                  ),
              }),
            );
          },
        },
      },
    } as unknown as IAgentRuntime;
    service = new MonthlyFamilyPacketService(
      runtime,
      () => new Date("2026-08-30T12:00:00.000Z"),
    );
  });

  afterEach(async () => db.close());

  it.each([
    ["2026-11", "2026-11-30"],
    ["2028-02", "2028-02-29"],
  ])("shows the inclusive final day in a %s draft", async (month, lastDay) => {
    const selectedPeriod = period(month);
    const packet = await service.buildInternal(selectedPeriod, []);
    const draft = await service.createExternalDraft(packet, guestDraft);
    const heading = draft.body.split("\n")[0];
    expect(heading).toContain(lastDay);
    expect(heading).not.toContain(selectedPeriod.endsOnExclusive);
  });

  it("rejects invalid civil-date boundaries before publishing a packet", async () => {
    await expect(
      service.buildInternal(
        { ...period("2026-02"), endsOnExclusive: "2026-02-30" },
        [],
      ),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_PERIOD_INVALID" });
    expect(await service.list("2026-02")).toEqual([]);
  });

  it("summarizes open requests across categories after recipient filtering and removes resolved requests", async () => {
    const open = claim("travel-request", {
      section: "travel_consent_health",
      statement: "Overnight travel is requested, not agreed.",
      requests: ["Please confirm the proposed overnight trip."],
      unanswered: true,
    });
    const privateRequest = claim("private-request", {
      section: "school",
      statement: "Private school concern",
      requests: ["Private school response needed"],
      visibility: "owner_only",
      unanswered: true,
    });
    const packet = await service.buildInternal(period("2026-11"), [
      open,
      privateRequest,
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    const unanswered = draft.body.split("## unanswered\n")[1];
    expect(unanswered).toContain(open.requests[0]);
    expect(unanswered).not.toContain("Missing:");
    expect(draft.body).not.toContain(privateRequest.requests[0]);
    expect(draft.includedClaimIds).toEqual([open.claimId]);
    const resolved = await service.buildInternal(period("2026-11"), [
      { ...open, unanswered: false },
      privateRequest,
    ]);
    const resolvedDraft = await service.createExternalDraft(
      resolved,
      guestDraft,
    );
    expect(resolvedDraft.body.split("## unanswered\n")[1]).not.toContain(
      open.requests[0],
    );
  });

  it("blocks a previously approved correspondence draft after withdrawal", async () => {
    const owner = randomUUID();
    const recipient = randomUUID();
    const documentId = randomUUID();
    const text = "Please confirm pickup at 3 PM.";
    const documents = {
      async getDocumentByIdWithAccessContext(id: UUID): Promise<Memory> {
        return {
          id,
          agentId: runtime.agentId,
          roomId: runtime.agentId,
          entityId: owner as UUID,
          content: { text },
          metadata: {
            type: "document",
            contentType: "text/plain",
            ingestionState: "ready",
          },
        };
      },
    };
    const intakeRuntime = {
      ...runtime,
      getSetting: (key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? owner : null,
      getService: (name: string) => (name === "documents" ? documents : null),
    } as unknown as IAgentRuntime;
    const packets = new MonthlyFamilyPacketService(intakeRuntime);
    const intake = getFamilyIntakeService(intakeRuntime);
    const selected = await intake.select({
      id: randomUUID(),
      periodKey: "2026-09",
      documentId,
    });
    const proposed = await intake.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      facts: [
        {
          id: randomUUID(),
          section: "unanswered",
          statement: text,
          sourceQuote: text,
          dates: [],
          requests: ["Confirm pickup"],
          commitments: [],
          accountability: [],
          urgency: null,
          unanswered: true,
          recipientEntityIds: [],
        },
      ],
    });
    const reviewed = await intake.review({
      id: selected.id,
      expectedRevision: proposed.revision,
      facts: proposed.facts.map((fact) => ({
        ...fact,
        recipientEntityIds: [recipient],
      })),
    });
    const sources = await intake.reviewedFacts("2026-09");
    const claims = sources.map(familyIntakeClaim);
    const packet = await packets.buildInternal(period("2026-09"), claims);
    const forgedDraft = await packets.createExternalDraft(
      {
        ...packet,
        claims: packet.claims.map((entry) => ({
          ...entry,
          statement: "Fabricated parental consent",
          intakeBinding: undefined,
        })),
      },
      { ...guestDraft, recipientEntityId: recipient },
    );
    expect(forgedDraft.body).toContain(text);
    expect(forgedDraft.body).not.toContain("Fabricated parental consent");
    const draft = await packets.createExternalDraft(packet, {
      ...guestDraft,
      recipientEntityId: recipient,
      email: { subject: "September coordination", senderGrantId: "sender-1" },
    });
    expect(draft.body).toContain(text);
    const request = await packets.enqueueDraftApproval({
      draft,
      queue: {
        enqueueTransactional: async (input) => ({
          request: approval(input),
          reused: false,
        }),
        surfaceEnqueuedApproval: async () => undefined,
      },
      requestedBy: owner,
      subjectUserId: owner,
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
    await expect(
      packets.validateApprovedDraft({ ...request, state: "approved" }),
    ).resolves.toMatchObject({ bodySha256: draft.bodySha256 });
    for (const month of ["2026-10", "2027-02"]) {
      const next = await packets.buildInternal(
        period(month),
        (await intake.reviewedFacts(month)).map(familyIntakeClaim),
      );
      expect(next.claims).toEqual(claims);
    }
    await intake.withdraw(reviewed.id, reviewed.revision);
    const afterWithdrawal = await packets.buildInternal(
      period("2027-03"),
      (await intake.reviewedFacts("2027-03")).map(familyIntakeClaim),
    );
    expect(afterWithdrawal.claims).toEqual([]);
    await expect(
      packets.validateApprovedDraft({ ...request, state: "approved" }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEW_CONFLICT" });
    await expect(
      packets.createExternalDraft(packet, {
        ...guestDraft,
        recipientEntityId: recipient,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEW_CONFLICT" });
    const store = new FamilyIntakeReviewStore(intakeRuntime);
    expect((await store.read(selected.id))?.status).toBe("withdrawn");
  });

  it("includes opted-in school source facts in the external draft without sharing private calendar edits", async () => {
    const event: LifeOpsCalendarEvent = {
      id: "school-local",
      externalId: "school-local",
      agentId: "agent-a",
      provider: "eliza",
      side: "owner",
      calendarId: "primary",
      grantId: "eliza-calendar",
      title: "Private custody discussion",
      description: "Private school note",
      location: "Private address",
      status: "confirmed",
      startAt: "2026-09-15T00:00:00.000Z",
      endAt: "2026-09-16T00:00:00.000Z",
      isAllDay: true,
      timezone: "America/New_York",
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    const claims = collectCalendarClaims(
      {
        calendarId: "all",
        events: [event],
        state: "complete",
        source: "synced",
        sources: [],
        timeMin: "2026-09-01T00:00:00.000Z",
        timeMax: "2026-10-01T00:00:00.000Z",
        syncedAt: "2026-08-30T12:00:00.000Z",
      },
      [],
      [
        {
          sourceId: "public-district",
          grantId: event.grantId,
          calendarId: event.calendarId,
          providerEventId: event.externalId,
          packetVisibility: "guest_shareable",
          event: {
            eventKey: "labor-day",
            title: "School closed for Labor Day",
            startDate: "2026-09-07",
            endDateExclusive: "2026-09-08",
          },
        },
      ],
    );
    const packet = await service.buildInternal(period("2026-09"), claims);
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).toContain("School closed for Labor Day");
    expect(draft.body).toContain("2026-09-07");
    expect(draft.body).not.toContain("Private");
    expect(draft.body).not.toContain("2026-09-15");
  });

  it("deduplicates simultaneous packet generation and retains both concurrent draft requests", async () => {
    const peer = new MonthlyFamilyPacketService(runtime);
    await service.list();
    await peer.list();
    const [first, duplicate] = await Promise.all([
      service.buildInternal(period("2026-09"), [claim("same")]),
      peer.buildInternal(period("2026-09"), [claim("same")]),
    ]);
    expect(duplicate).toEqual(first);
    const [left, right] = await Promise.all([
      service.createExternalDraft(first, guestDraft),
      peer.createExternalDraft(first, guestDraft),
    ]);
    expect(left.draftVersion).not.toBe(right.draftVersion);
    expect(await service.readDraft(left.packetId, left.draftVersion)).toEqual(
      left,
    );
    expect(await service.readDraft(right.packetId, right.draftVersion)).toEqual(
      right,
    );
    const changed = await Promise.all([
      service.buildInternal(period("2026-09"), [claim("changed-a")]),
      peer.buildInternal(period("2026-09"), [claim("changed-b")]),
    ]);
    expect(changed[0].version).not.toBe(changed[1].version);
    for (const packet of changed)
      expect(await service.read(packet.packetId, packet.version)).toEqual(
        packet,
      );
  });

  it("rejects an approval if regeneration commits while approval publication waits", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("initial"),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    beforeNextTransaction = async () => {
      reached.resolve();
      await resume.promise;
    };
    const queue = {
      enqueueTransactional: vi.fn(async (input: ApprovalEnqueueInput) => ({
        request: approval(input),
        created: true,
      })),
      surfaceEnqueuedApproval: vi.fn(async () => undefined),
    };
    const pending = service.enqueueDraftApproval({
      draft,
      queue,
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-09-30T12:00:00.000Z"),
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "FAMILY_PACKET_INTERNAL_STALE",
    });
    await reached.promise;
    try {
      await service.buildInternal(period("2026-09"), [claim("replacement")]);
    } finally {
      resume.resolve();
    }
    await rejected;
    expect(queue.enqueueTransactional).not.toHaveBeenCalled();
    expect(queue.surfaceEnqueuedApproval).not.toHaveBeenCalled();
    expect(
      await service.readDraftApprovalId(draft.packetId, draft.draftVersion),
    ).toBeNull();
  });

  it.each(["packet", "draft", "revision", "approval"] as const)(
    "rejects a %s mutation after the workspace fence without persisting private data",
    async (kind) => {
      const packet = await service.buildInternal(period("2026-09"), [
        claim("a"),
      ]);
      const draft = await service.createExternalDraft(packet, {
        ...guestDraft,
        email: { subject: "September plans", senderGrantId: "sender-1" },
      });
      await ensureFamilyWorkspaceOperationStore(runtime);
      await db.query(
        "UPDATE app_lifeops.life_family_workspace_state SET state='revoking' WHERE agent_id='agent-a'",
      );
      const before = await db.query(
        "SELECT packet_json FROM app_lifeops.life_family_packets ORDER BY internal_version",
      );
      const draftsBefore = await db.query(
        "SELECT * FROM app_lifeops.life_family_packet_drafts ORDER BY draft_version",
      );
      const queue = {
        enqueueTransactional: vi.fn(async (input: ApprovalEnqueueInput) => ({
          request: approval(input),
          reused: false,
        })),
        surfaceEnqueuedApproval: vi.fn(async () => undefined),
      };
      const mutate = () => {
        switch (kind) {
          case "packet":
            return service.buildInternal(period("2026-09"), [
              claim("new-private-source"),
            ]);
          case "draft":
            return service.createExternalDraft(packet, guestDraft);
          case "revision":
            return service.reviseDraft({
              packetId: packet.packetId,
              expectedDraftVersion: draft.draftVersion,
              subject: "Revised plans",
              body: "A new private revision",
            });
          case "approval":
            return service.enqueueDraftApproval({
              draft,
              queue,
              requestedBy: "owner",
              subjectUserId: "owner",
              expiresAt: new Date("2026-10-01T00:00:00Z"),
            });
        }
      };
      await expect(mutate()).rejects.toMatchObject({
        code: "FAMILY_WORKSPACE_FENCED",
      });
      expect(
        (
          await db.query(
            "SELECT packet_json FROM app_lifeops.life_family_packets ORDER BY internal_version",
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await db.query(
            "SELECT * FROM app_lifeops.life_family_packet_drafts ORDER BY draft_version",
          )
        ).rows,
      ).toEqual(draftsBefore.rows);
      expect(queue.enqueueTransactional).not.toHaveBeenCalled();
      expect(queue.surfaceEnqueuedApproval).not.toHaveBeenCalled();
    },
  );

  it("holds deletion through approval reminder surfacing and releases the claim after completion", async () => {
    const packet = await service.buildInternal(period("2026-09"), [claim("a")]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = service.enqueueDraftApproval({
      draft,
      queue: {
        enqueueTransactional: async (input) => ({
          request: approval(input),
          reused: false,
        }),
        surfaceEnqueuedApproval: async () => {
          entered();
          await pending;
        },
      },
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
    await started;
    try {
      await expect(
        withRequiredTransaction(runtime, (tx) =>
          fenceFamilyWorkspace(tx, runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    } finally {
      release();
    }
    await work;
    await withRequiredTransaction(runtime, (tx) =>
      fenceFamilyWorkspace(tx, runtime.agentId),
    );
    await expect(
      new MonthlyFamilyPacketService(runtime).buildInternal(period("2026-10"), [
        claim("later"),
      ]),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
  });

  it("retains reconciliation identity when approval reminder completion is unknown", async () => {
    const packet = await service.buildInternal(period("2026-09"), [claim("a")]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    await expect(
      service.enqueueDraftApproval({
        draft,
        queue: {
          enqueueTransactional: async (input) => ({
            request: approval(input),
            reused: false,
          }),
          surfaceEnqueuedApproval: async () => {
            throw new Error("reminder acknowledgement lost");
          },
        },
        requestedBy: "owner",
        subjectUserId: "owner",
        expiresAt: new Date("2026-10-01T00:00:00Z"),
      }),
    ).rejects.toThrow("reminder acknowledgement lost");
    const rows = await db.query(
      "SELECT target_json FROM app_lifeops.life_family_workspace_operations WHERE agent_id='agent-a'",
    );
    expect(rows.rows).toEqual([
      {
        target_json: {
          kind: "family-packet-approval",
          packetId: packet.packetId,
          draftVersion: draft.draftVersion,
        },
      },
    ]);
    await ensureFamilyWorkspaceOperationStore(runtime);
    await expect(
      withRequiredTransaction(runtime, (tx) =>
        fenceFamilyWorkspace(tx, runtime.agentId),
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
  });

  it("survives restart, preserves provenance, deduplicates content, and versions changed internal packets", async () => {
    const first = await service.buildInternal(period("2026-09"), [claim("a")]);
    const restarted = new MonthlyFamilyPacketService(runtime);
    const duplicate = await restarted.buildInternal(period("2026-09"), [
      claim("a"),
    ]);
    expect(duplicate.version).toBe(1);
    expect(duplicate.contentSha256).toBe(first.contentSha256);
    expect(duplicate.claims[0]?.provenance[0]?.sourceId).toBe("source-a");

    const changed = await restarted.buildInternal(period("2026-09"), [
      claim("a", { requests: ["Please confirm pickup by September 2."] }),
    ]);
    expect(changed.version).toBe(2);
    expect(changed.contentSha256).not.toBe(first.contentSha256);
  });

  it("distinguishes missing from contradictory sections and retains all conflicting provenance", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("school-a", {
        stableKey: "school:first-day",
        section: "school",
        statement: "School starts September 1.",
        provenance: [
          {
            source: "school",
            sourceId: "district-pdf",
            observedAt: "2026-08-30T12:00:00.000Z",
            contentSha256: digest("pdf"),
          },
        ],
      }),
      claim("school-b", {
        stableKey: "school:first-day",
        section: "school",
        statement: "School starts September 2.",
        provenance: [
          {
            source: "knowledge",
            sourceId: "pinned-note",
            observedAt: "2026-08-29T12:00:00.000Z",
            contentSha256: digest("note"),
          },
        ],
      }),
    ]);
    expect(
      packet.sections.find((entry) => entry.section === "school")?.state,
    ).toBe("contradictory");
    expect(
      packet.sections.find((entry) => entry.section === "approved_obligations")
        ?.state,
    ).toBe("missing");
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).toContain("Needs resolution");
    expect(draft.body).not.toContain("district-pdf");
    expect(draft.body).not.toContain("pinned-note");
  });

  it("carries an unanswered item forward exactly once", async () => {
    await service.buildInternal(period("2026-09"), [
      claim("answer-me", {
        section: "unanswered",
        unanswered: true,
        carryForwardCount: 0,
        requests: ["Please confirm."],
      }),
    ]);
    const october = await service.buildInternal(period("2026-10"), []);
    expect(october.claims).toHaveLength(1);
    expect(october.claims[0]?.carryForwardCount).toBe(1);
    expect(october.claims[0]?.carriedFromClaimId).toBe("answer-me");
    const november = await service.buildInternal(period("2026-11"), []);
    expect(november.claims).toHaveLength(0);
  });

  it("omits owner-only material, excludes unapproved obligations, and rejects expenses by construction", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("private", {
        visibility: "owner_only",
        statement: "private medical detail canary",
      }),
      claim("obligation", {
        section: "approved_obligations",
        statement: "Unapproved notice canary",
        obligationApprovalId: null,
      }),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).not.toContain("private medical detail canary");
    expect(draft.body).not.toContain("Unapproved notice canary");
    expect(draft.transformations.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "private_claim_omitted",
        "unapproved_obligation_omitted",
      ]),
    );

    await expect(
      service.buildInternal(period("2026-10"), [
        { ...claim("expense"), section: "expenses" } as never,
      ]),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_EXPENSE_FORBIDDEN" });
    await expect(
      service.buildInternal(period("2026-10"), [
        { ...claim("expense-class"), dataClass: "expense" } as never,
      ]),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_EXPENSE_FORBIDDEN" });
  });

  it("binds calendar projection to the recipient Entity and requested privacy mode", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("custody", { statement: "Private custody title" }),
    ]);
    const wrongGuest = await service.createExternalDraft(packet, {
      ...guestDraft,
      recipientEntityId: "guest-2",
    });
    expect(wrongGuest.body).not.toContain("Private custody title");
    expect(wrongGuest.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "recipient_acl_omitted" }),
      ]),
    );

    const timesOnly = await service.createExternalDraft(packet, {
      ...guestDraft,
      calendarPrivacyMode: "times_only",
    });
    expect(timesOnly.body).toContain("Scheduled event");
    expect(timesOnly.body).not.toContain("Private custody title");
    expect(timesOnly.body).not.toContain("source-custody");

    const busyOnly = await service.createExternalDraft(packet, {
      ...guestDraft,
      calendarPrivacyMode: "busy_only",
    });
    expect(busyOnly.body).toContain("Busy");
    expect(busyOnly.body).not.toContain("Private custody title");

    const full = await service.createExternalDraft(packet, guestDraft);
    expect(full.body).toContain("Private custody title");
  });

  it("saves owner edits as a new immutable email version and rejects the previous approval", async () => {
    const packet = await service.buildInternal(period("2026-09"), [claim("a")]);
    const first = await service.createExternalDraft(packet, {
      ...guestDraft,
      email: { subject: "September", senderGrantId: "sender-1" },
    });
    const request = await service.enqueueDraftApproval({
      draft: first,
      queue: {
        enqueueTransactional: async (input) => ({
          request: approval(input),
          reused: false,
        }),
        surfaceEnqueuedApproval: async () => undefined,
      },
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
    const revised = await service.reviseDraft({
      packetId: first.packetId,
      expectedDraftVersion: first.draftVersion,
      subject: "September plans",
      body: "Please confirm pickup at 3 PM.\nThank you.",
    });
    expect(revised.bodySha256).toBe(digest(revised.body));
    expect(revised.recipient).toBe(first.recipient);
    expect(revised.email).toEqual({
      subject: "September plans",
      senderGrantId: "sender-1",
    });
    expect(
      (await service.readDraft(first.packetId, first.draftVersion))?.body,
    ).toBe(first.body);
    expect(
      await service.readDraftApprovalId(first.packetId, revised.draftVersion),
    ).toBeNull();
    await expect(
      service.validateApprovedDraft({ ...request, state: "approved" }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_APPROVAL_STALE" });
    await expect(
      service.reviseDraft({
        packetId: first.packetId,
        expectedDraftVersion: first.draftVersion,
        subject: "Stale",
        body: "Stale edit",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_DRAFT_STALE" });
  });

  it("keeps invalid or private edits out of persisted drafts and serializes concurrent edits", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("private", {
        visibility: "owner_only",
        statement: "Private canary",
      }),
    ]);
    const first = await service.createExternalDraft(packet, {
      ...guestDraft,
      email: { subject: "Plans", senderGrantId: "sender-1" },
    });
    const input = {
      packetId: first.packetId,
      expectedDraftVersion: first.draftVersion,
      subject: "Updated plans",
      body: "A safe owner edit",
    };
    await expect(
      service.reviseDraft({ ...input, body: "" }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_EDIT_INVALID" });
    await expect(
      service.reviseDraft({ ...input, body: "Private canary" }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_PRIVACY_LEAK" });
    await expect(
      service.reviseDraft({
        ...input,
        subject: "Plans\nBcc: stranger@example.test",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_EDIT_INVALID" });
    expect((await service.readLatestDraft(first.packetId))?.draftVersion).toBe(
      first.draftVersion,
    );
    const raced = await Promise.allSettled([
      service.reviseDraft(input),
      service.reviseDraft({ ...input, body: "A competing edit" }),
    ]);
    expect(
      raced.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    expect((await service.readLatestDraft(first.packetId))?.draftVersion).toBe(
      first.draftVersion + 1,
    );
  });

  it("omits agreement claims when the exact resource grant cannot be proven", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("agreement", {
        section: "approved_obligations",
        statement: "Agreement obligation canary",
        obligationApprovalId: "approved-obligation",
        agreementArtifactId: "agreement-artifact",
      }),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).not.toContain("Agreement obligation canary");
    expect(draft.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agreement_grant_omitted" }),
      ]),
    );
  });

  it("preserves material fields without inventing apology, legal, or therapy claims", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("travel", {
        section: "travel_consent_health",
        statement: "Trip is planned.",
        dates: ["2026-09-12 through 2026-09-15"],
        requests: ["Please provide consent by 2026-09-05."],
        urgency: "Reply needed before booking.",
        commitments: ["I will share the itinerary."],
        accountability: ["Alex owns the consent response."],
      }),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    for (const exact of [
      "2026-09-12 through 2026-09-15",
      "Please provide consent by 2026-09-05.",
      "Reply needed before booking.",
      "I will share the itinerary.",
    ]) {
      expect(draft.body).toContain(exact);
    }
    expect(draft.body).not.toContain("Alex owns the consent response.");
    expect(draft.body.toLowerCase()).not.toMatch(
      /sorry|apolog|legal advice|therapy/,
    );
  });

  it("uses the canonical approval queue and rejects stale or tampered drafts and approvals", async () => {
    const packet = await service.buildInternal(period("2026-09"), [claim("a")]);
    const first = await service.createExternalDraft(packet, guestDraft);
    let enqueued: ApprovalRequest | null = null;
    const queue = {
      enqueueTransactional: vi.fn(async (input: ApprovalEnqueueInput) => {
        enqueued = approval(input);
        return { request: enqueued, reused: false };
      }),
      surfaceEnqueuedApproval: vi.fn(async () => undefined),
    };
    await service.enqueueDraftApproval({
      draft: first,
      queue,
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(queue.enqueueTransactional).toHaveBeenCalledOnce();
    expect(queue.surfaceEnqueuedApproval).toHaveBeenCalledOnce();
    await expect(
      service.readLatestDraft(packet.packetId),
    ).resolves.toMatchObject({
      draftVersion: first.draftVersion,
      recipientEntityId: "guest-1",
    });
    await expect(
      service.readDraftApprovalId(packet.packetId, first.draftVersion),
    ).resolves.toBe("approval-1");
    expect(enqueued?.payload).toMatchObject({
      action: "send_message",
      recipient: "guest@example.com",
      body: first.body,
    });

    const approved = {
      ...(enqueued as unknown as ApprovalRequest),
      state: "approved" as const,
    };
    await expect(
      service.validateApprovedDraft(approved),
    ).resolves.toMatchObject({
      bodySha256: first.bodySha256,
    });
    const tampered = {
      ...approved,
      payload: { ...approved.payload, body: `${first.body}\nchanged` },
    } as ApprovalRequest;
    await expect(service.validateApprovedDraft(tampered)).rejects.toMatchObject(
      {
        code: "FAMILY_PACKET_APPROVAL_TAMPERED",
      },
    );

    const second = await service.createExternalDraft(packet, guestDraft);
    expect(second.internalVersion).toBe(first.internalVersion);
    expect(second.draftVersion).toBe(first.draftVersion + 1);
    await expect(service.validateApprovedDraft(approved)).rejects.toMatchObject(
      {
        code: "FAMILY_PACKET_APPROVAL_STALE",
      },
    );
    await expect(
      service.enqueueDraftApproval({
        draft: { ...first, body: `${first.body}\ntampered` },
        queue,
        requestedBy: "owner",
        subjectUserId: "owner",
        expiresAt: new Date("2026-09-05T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_DRAFT_TAMPERED" });
  });

  it("binds email approval to the persisted sender, recipient, subject and body", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("email-plan"),
    ]);
    const draft = await service.createExternalDraft(packet, {
      ...guestDraft,
      email: {
        subject: "September family plans",
        senderGrantId: "test-account",
      },
    });
    const queue = {
      enqueueTransactional: async (input: ApprovalEnqueueInput) => ({
        request: approval(input),
        reused: false,
      }),
      surfaceEnqueuedApproval: async () => undefined,
    };
    const request = await service.enqueueDraftApproval({
      draft,
      queue,
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-09-05T00:00:00Z"),
    });
    const approved = { ...request, state: "approved" as const };
    expect(request.action).toBe("send_email");
    await expect(
      service.validateApprovedDraft(approved),
    ).resolves.toMatchObject({ email: draft.email });
    if (approved.payload.action !== "send_email")
      throw new Error("expected email");
    for (const change of [
      { grantId: "replacement-account" },
      { familyPacketId: "another-packet" },
      { to: ["someone-else@example.com"] },
      { subject: "Changed subject" },
      { body: `${draft.body}\nChanged` },
      { bcc: ["hidden@example.com"] },
    ]) {
      await expect(
        service.validateApprovedDraft({
          ...approved,
          payload: { ...approved.payload, ...change },
        }),
      ).rejects.toMatchObject({ code: "FAMILY_PACKET_APPROVAL_TAMPERED" });
    }
  });
  it("keeps versioned draft history while rejecting approval against replaced source evidence", async () => {
    const firstPacket = await service.buildInternal(period("2026-09"), [
      claim("first"),
    ]);
    const firstDraft = await service.createExternalDraft(
      firstPacket,
      guestDraft,
    );
    const queue = {
      enqueueTransactional: vi.fn(async (input: ApprovalEnqueueInput) => ({
        request: approval(input),
        reused: false,
      })),
      surfaceEnqueuedApproval: vi.fn(async () => undefined),
    };
    const input = {
      draft: firstDraft,
      queue,
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-09-05T00:00:00.000Z"),
    };
    const request = await service.enqueueDraftApproval(input);
    const secondPacket = await service.buildInternal(period("2026-09"), [
      claim("replacement"),
    ]);
    await expect(
      service.readLatestDraft(firstPacket.packetId, firstPacket.version),
    ).resolves.toMatchObject({ draftVersion: firstDraft.draftVersion });
    await expect(
      service.readLatestDraft(secondPacket.packetId, secondPacket.version),
    ).resolves.toBeNull();
    await expect(service.enqueueDraftApproval(input)).rejects.toMatchObject({
      code: "FAMILY_PACKET_INTERNAL_STALE",
    });
    await expect(
      service.validateApprovedDraft({ ...request, state: "approved" }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_INTERNAL_STALE" });
    expect(queue.enqueueTransactional).toHaveBeenCalledTimes(1);
    const secondDraft = await service.createExternalDraft(
      secondPacket,
      guestDraft,
    );
    await expect(
      service.readLatestDraft(secondPacket.packetId, secondPacket.version),
    ).resolves.toMatchObject({
      draftVersion: secondDraft.draftVersion,
      internalVersion: secondPacket.version,
    });
    await expect(
      service.readLatestDraft(firstPacket.packetId, firstPacket.version),
    ).resolves.toMatchObject({
      draftVersion: firstDraft.draftVersion,
      internalVersion: firstPacket.version,
    });
  });
});
