/** Synthetic agreement, email review, and approval state; no method can call a live provider. */
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
  FamilyPacketView,
} from "../../src/components/family-operations/types.js";

export function createFamilyPacketFixture(
  failRevision: boolean,
  uncertainDecision = false,
): FamilyOperationsAdapter {
  let packet: FamilyPacketView = {
    packetId: "fixture-packet",
    periodKey: "2026-10",
    version: 1,
    createdAt: "2026-09-20T12:00:00Z",
    status: "complete",
    sections: [],
    claims: [
      {
        id: "private",
        section: "travel_consent_health",
        text: "Private fixture canary",
      },
    ],
    draft: {
      draftVersion: 1,
      bodySha256: "",
      approval: null,
      recipient: "guest@example.test",
      recipientEntityId: "fixture-guest",
      calendarPrivacyMode: "busy_only",
      body: "Please confirm the October pickup schedule.",
      email: { subject: "October plans", senderGrantId: "fixture-sender" },
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("This operation is outside the synthetic email fixture.");
  };
  async function digest(body: string): Promise<string> {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    return Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  const pins: Awaited<ReturnType<FamilyOperationsAdapter["listPins"]>> = [];
  const guestGrants: Awaited<
    ReturnType<FamilyOperationsAdapter["issueGrant"]>
  >[] = [];
  const guestChoices: Awaited<
    ReturnType<FamilyOperationsAdapter["listGuestAccessOptions"]>
  >["candidates"] = [
    {
      principalEntityId: "fixture-guest",
      householdGrantId: "fixture-permission-alex",
      displayName: "Alex",
      identityLabel: "email: alex@example.test",
      role: "co_parent",
      expiresAt: null,
      issuedAt: "2026-09-20T12:00:00Z",
    },
    {
      principalEntityId: "fixture-caregiver",
      householdGrantId: "fixture-permission-sam",
      displayName: "Sam",
      identityLabel: "email: sam@example.test",
      role: "caregiver",
      expiresAt: null,
      issuedAt: "2026-09-20T12:00:00Z",
    },
  ];
  return {
    async decidePacketApproval(input) {
      const draft = packet.draft;
      if (
        input.packetId !== packet.packetId ||
        !draft?.approval ||
        input.draftVersion !== draft.draftVersion ||
        input.approvalId !== draft.approvalId ||
        input.bodySha256 !== draft.bodySha256
      )
        throw new Error("Fixture decision does not match the reviewed draft.");
      if (draft.approval.state !== "pending")
        throw new Error("Fixture approval already has a decision.");
      document.documentElement.dataset.familyDecision = input.decision;
      if (input.decision === "reject") {
        draft.approval.state = "rejected";
      } else if (uncertainDecision) {
        draft.approval.state = "reconciliation_required";
        draft.approval.error = "Fixture provider outcome is unknown.";
        throw new Error("Check the provider record before retrying.");
      } else {
        draft.approval.state = "done";
        draft.approval.providerAccepted = true;
        draft.approval.providerMessageId = "synthetic-provider-receipt";
      }
    },
    listRecipientContacts: unsupported,
    confirmEmailRecipient: unsupported,
    async load(): Promise<FamilyOperationsSnapshot> {
      if (packet.draft)
        packet.draft.bodySha256 = await digest(packet.draft.body);
      return {
        agreements: {
          status: "ready",
          data: [
            {
              artifact: {
                id: "fixture-agreement",
                agentId: "fixture-agent",
                householdId: "default",
                agreementKey: "synthetic-plan",
                version: 1,
                supersedesArtifactId: null,
                title: "Synthetic parenting plan",
                originalFilename: "synthetic-plan.pdf",
                documentId: "fixture-document",
                mediaUrl: "/api/media/fixture.pdf",
                mediaFileName: "fixture.pdf",
                contentSha256: "a".repeat(64),
                mimeType: "application/pdf",
                byteSize: 2048,
                pageCount: 3,
                uploadedByEntityId: "self",
                createdAt: "2026-09-20T12:00:00Z",
              },
              obligations: [],
            },
          ],
        },
        calendarLinks: { status: "ready", data: [] },
        school: {
          status: "unavailable",
          message: "School source is outside this fixture.",
        },
        packets: { status: "ready", data: [structuredClone(packet)] },
        emailOptions: {
          status: "ready",
          data: {
            accounts: [
              { grantId: "fixture-sender", label: "owner@example.test" },
            ],
            recipients: [
              {
                entityId: "fixture-guest",
                name: "Verified fixture guest",
                address: "guest@example.test",
              },
            ],
          },
        },
      };
    },
    async revisePacketDraft(input) {
      if (failRevision) throw new Error("Fixture revision could not be saved.");
      if (
        !packet.draft?.email ||
        packet.draft.draftVersion !== input.expectedDraftVersion
      )
        throw new Error("Fixture draft is stale.");
      packet = {
        ...packet,
        draft: {
          ...packet.draft,
          draftVersion: packet.draft.draftVersion + 1,
          body: input.body,
          bodySha256: await digest(input.body),
          approval: null,
          email: { ...packet.draft.email, subject: input.subject },
          approvalId: undefined,
        },
      };
    },
    async requestPacketApproval(packetId, version) {
      if (
        packetId !== packet.packetId ||
        packet.draft?.draftVersion !== version
      )
        throw new Error("Fixture approval is stale.");
      document.documentElement.dataset.familyApprovalVersion = String(version);
      packet.draft.approvalId = `fixture-approval-${version}`;
      packet.draft.approval = {
        id: packet.draft.approvalId,
        state: "pending",
        providerAccepted: null,
        providerMessageId: null,
        error: null,
        updatedAt: "2026-09-20T12:01:00Z",
      };
    },
    uploadAgreement: unsupported,
    downloadAgreement: unsupported,
    downloadWorkspace: unsupported,
    readAgreementReview: async () => null,
    addAgreementProposal: async () => {
      throw new Error("Owner correction is unavailable in this fixture");
    },
    prepareAgreementReview: unsupported,
    decideObligation: unsupported,
    async listPinTargets() {
      return {
        agent: { id: "fixture-agent", name: "Family assistant" },
        chats: [
          {
            id: "fixture-acceptance-chat",
            name: "Family planning",
            source: "test",
          },
        ],
      };
    },
    async listPins(artifactId) {
      return pins
        .filter(
          (pin) => pin.artifactId === artifactId && pin.unpinnedAt === null,
        )
        .map((pin) => ({ ...pin }));
    },
    async pin(input) {
      if (
        input.targetId !==
        (input.targetType === "agent"
          ? "fixture-agent"
          : "fixture-acceptance-chat")
      )
        throw new Error("Unknown fixture pin destination");
      const pin = {
        ...input,
        id: `fixture-pin-${pins.length}`,
        agentId: "fixture-agent",
        pinnedByEntityId: "self",
        pinnedAt: "2026-09-20T12:00:00Z",
        unpinnedAt: null,
      };
      pins.push(pin);
      document.documentElement.dataset.familyPinTarget = input.targetId;
      return { ...pin };
    },
    async unpin(pinId) {
      const pin = pins.find((item) => item.id === pinId);
      if (!pin) throw new Error("Unknown fixture pin");
      pin.unpinnedAt = "2026-09-20T12:01:00Z";
      return { ...pin };
    },
    async listGuestAccessOptions(artifactId) {
      return {
        candidates: guestChoices.map((item) => ({ ...item })),
        grants: guestGrants
          .filter(
            (item) => item.artifactId === artifactId && item.revokedAt === null,
          )
          .map((item) => ({
            grantId: item.id,
            principalEntityId: item.principalEntityId,
            householdGrantId: item.householdGrantId,
            displayName:
              guestChoices.find(
                (choice) => choice.principalEntityId === item.principalEntityId,
              )?.displayName ?? null,
            issuedAt: item.createdAt,
            canRead: true,
            denial: null,
          })),
      };
    },
    async previewGrant(input) {
      const allowed =
        input.artifactId === "fixture-agreement" &&
        guestChoices.some(
          (item) =>
            item.householdGrantId === input.householdGrantId &&
            item.principalEntityId === input.principalEntityId,
        );
      return {
        ...input,
        allowed,
        effects: ["read_artifact_metadata", "read_approved_obligations"],
        exclusions: [
          "read_proposed_or_rejected_obligations",
          "mutate_agreement",
          "inherit_access_from_pin",
        ],
        denial: allowed
          ? null
          : {
              code: "AGREEMENT_ACCESS_DENIED",
              message: "No matching synthetic guest permission.",
            },
      };
    },
    async issueGrant(input) {
      if (
        input.artifactId !== "fixture-agreement" ||
        !guestChoices.some(
          (item) =>
            item.householdGrantId === input.householdGrantId &&
            item.principalEntityId === input.principalEntityId,
        )
      )
        throw new Error("Unrecognized synthetic guest permission");
      const grant = {
        ...input,
        id: `fixture-guest-grant-${guestGrants.length}`,
        agentId: "fixture-agent",
        householdId: "default",
        issuedByEntityId: "self",
        revokedAt: null,
        revokedByEntityId: null,
        revocationReason: null,
        createdAt: "2026-09-20T12:00:00Z",
        updatedAt: "2026-09-20T12:00:00Z",
      };
      guestGrants.push(grant);
      document.documentElement.dataset.familyGuestTarget =
        input.principalEntityId;
      return { ...grant };
    },
    async revokeGrant(grantId, reason) {
      const grant = guestGrants.find((item) => item.id === grantId);
      if (!grant) throw new Error("Unknown synthetic guest grant");
      grant.revokedAt = "2026-09-20T12:01:00Z";
      grant.revokedByEntityId = "self";
      grant.revocationReason = reason;
      return { ...grant };
    },
    resolveCalendarConflict: unsupported,
    disconnectCalendar: unsupported,
    runSchoolWorkflow: unsupported,
    configureSchool: unsupported,
    approveSchoolDiff: unsupported,
    generatePacket: unsupported,
    createPacketDraft: unsupported,
  };
}
