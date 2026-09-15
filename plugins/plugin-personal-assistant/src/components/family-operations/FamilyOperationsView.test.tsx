// @vitest-environment jsdom

/** Family Operations component behavior with controlled adapter boundaries. */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
} from "./types.js";

vi.mock("./adapter.js", () => ({ defaultFamilyOperationsAdapter: {} }));

import { FamilyOperationsView } from "./FamilyOperationsView.js";
import type { FamilyIntakeAdapter } from "./intake-adapter.js";

afterEach(cleanup);

function snapshot(): FamilyOperationsSnapshot {
  return {
    agreements: {
      status: "ready",
      data: [
        {
          artifact: {
            id: "artifact-1",
            agentId: "agent-1",
            householdId: "default",
            agreementKey: "parenting-plan",
            version: 1,
            supersedesArtifactId: null,
            title: "Parenting plan",
            originalFilename: "plan.pdf",
            documentId: "document-1",
            mediaUrl: "/api/media/hash.pdf",
            mediaFileName: "hash.pdf",
            contentSha256: "abcdef0123456789",
            mimeType: "application/pdf",
            byteSize: 2048,
            pageCount: 12,
            uploadedByEntityId: "self",
            createdAt: "2026-08-30T12:00:00.000Z",
          },
          obligations: [
            {
              id: "obligation-1",
              agentId: "agent-1",
              artifactId: "artifact-1",
              title: "School notice",
              obligationText: "Share school notices within 24 hours.",
              pageStart: 4,
              pageEnd: 5,
              citationText: "Each parent shall forward school notices.",
              status: "proposed",
              proposedByEntityId: "agent-1",
              decidedByEntityId: null,
              decisionReason: null,
              decidedAt: null,
              createdAt: "2026-08-30T12:00:00.000Z",
              updatedAt: "2026-08-30T12:00:00.000Z",
            },
          ],
        },
      ],
    },
    calendarLinks: {
      status: "ready",
      data: [
        {
          id: "link-1",
          localEventId: "school-pickup",
          event: {
            title: "School pickup",
            startAt: "2026-09-10T19:00:00Z",
            endAt: "2026-09-10T20:00:00Z",
            isAllDay: false,
          },
          providerCalendarId: "primary",
          state: "conflicted",
          updatedAt: "2026-08-30T12:00:00.000Z",
        },
      ],
    },
    school: { status: "unavailable", message: "School API is not installed." },
    packets: { status: "ready", data: [] },
    emailOptions: {
      status: "ready",
      data: {
        accounts: [{ grantId: "sender-1", label: "owner@example.com" }],
        recipients: [
          { entityId: "guest-1", name: "Alex", address: "guest@example.com" },
        ],
      },
    },
  };
}

function guestOptions(): Awaited<
  ReturnType<FamilyOperationsAdapter["listGuestAccessOptions"]>
> {
  return {
    candidates: [
      {
        principalEntityId: "guest-1",
        householdGrantId: "grant-1",
        displayName: "Alex",
        identityLabel: "email: alex@example.test",
        role: "co_parent",
        expiresAt: null,
        issuedAt: "2026-09-12T12:00:00Z",
      },
      {
        principalEntityId: "guest-2",
        householdGrantId: "grant-2",
        displayName: "Sam",
        identityLabel: "email: sam@example.test",
        role: "caregiver",
        expiresAt: null,
        issuedAt: "2026-09-12T12:00:00Z",
      },
    ],
    grants: [
      {
        grantId: "guest-grant-1",
        principalEntityId: "guest-1",
        householdGrantId: "grant-1",
        displayName: "Alex",
        issuedAt: "2026-09-12T12:00:00Z",
        canRead: true,
        denial: null,
      },
    ],
  };
}

function adapter(data = snapshot()): FamilyOperationsAdapter {
  return {
    load: vi.fn(async () => data),
    readAgreementReview: vi.fn(async () => null),
    addAgreementProposal: async () => {
      throw new Error("Owner correction is unavailable in this fixture");
    },
    prepareAgreementReview: vi.fn(async () => {
      throw new Error("Review generation is not configured in this fixture");
    }),
    decideObligation: vi.fn(async (obligation, decision, reason) => ({
      ...obligation,
      status: decision === "approve" ? "approved" : "rejected",
      decisionReason: reason,
    })),
    listPinTargets: async () => ({
      agent: { id: "fixture-agent", name: "Family assistant" },
      chats: [{ id: "fixture-chat", name: "Family planning", source: "test" }],
    }),
    listPins: vi.fn(async () => []),
    pin: vi.fn(),
    unpin: vi.fn(),
    listGuestAccessOptions: vi.fn(async () => guestOptions()),
    previewGrant: vi.fn(async () => ({
      allowed: false,
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "grant-1",
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: {
        code: "AGREEMENT_ACCESS_DENIED",
        message: "Identity is not verified.",
      },
    })),
    issueGrant: vi.fn(),
    revokeGrant: vi.fn(),
    resolveCalendarConflict: vi.fn(async () => undefined),
    disconnectCalendar: vi.fn(async () => undefined),
    runSchoolWorkflow: vi.fn(async () => undefined),
    configureSchool: vi.fn(async () => undefined),
    updateMonthlySchedule: vi.fn(async () => undefined),
    approveSchoolDiff: vi.fn(async () => undefined),
    generatePacket: vi.fn(async () => undefined),
    uploadAgreement: vi.fn(async () => undefined),
    downloadAgreement: vi.fn(async () => new Blob()),
    downloadWorkspace: vi.fn(
      async () => new Blob([], { type: "application/zip" }),
    ),
    createPacketDraft: vi.fn(async () => undefined),
    revisePacketDraft: vi.fn(async () => undefined),
    requestPacketApproval: vi.fn(async () => undefined),
    decidePacketApproval: vi.fn(async () => undefined),
  } as FamilyOperationsAdapter;
}

function pendingEmailSnapshot(): FamilyOperationsSnapshot {
  const data = snapshot();
  data.packets = {
    status: "ready",
    data: [
      {
        packetId: "decision-packet",
        periodKey: "2026-10",
        version: 1,
        createdAt: "2026-09-10T12:00:00Z",
        status: "complete",
        sections: [],
        claims: [],
        draft: {
          draftVersion: 1,
          recipient: "guest@example.test",
          recipientEntityId: "guest-1",
          calendarPrivacyMode: "busy_only",
          body: "Synthetic reviewed email.",
          bodySha256: "d".repeat(64),
          email: { subject: "Review", senderGrantId: "sender-1" },
          approvalId: "approval-1",
          approval: {
            id: "approval-1",
            state: "pending",
            providerAccepted: null,
            providerMessageId: null,
            error: null,
            updatedAt: "2026-09-10T12:00:00Z",
          },
        },
      },
    ],
  };
  return data;
}

function openPacketMonth(month: string) {
  const input = screen.getByLabelText("Month to prepare") as HTMLInputElement;
  if (input.value === month) return;
  fireEvent.change(input, { target: { value: month } });
  fireEvent.click(
    screen.getByRole("button", { name: "Open month", exact: true }),
  );
}

describe("FamilyOperationsView", () => {
  it("keeps the decision reason and approval gate specific to each proposed clause", async () => {
    const data = snapshot();
    if (data.agreements.status !== "ready")
      throw new Error("Expected agreement fixture");
    const source = data.agreements.data[0];
    source.obligations.push({
      ...source.obligations[0],
      id: "travel-clause",
      title: "Travel notice",
    });
    const local = adapter(data);
    render(<FamilyOperationsView adapter={local} />);
    const school = (await screen.findByText("School notice")).closest(
      "article",
    );
    const travel = screen.getByText("Travel notice").closest("article");
    if (!school || !travel) throw new Error("Expected both proposal cards");
    fireEvent.change(within(school).getByLabelText("Decision reason"), {
      target: { value: "Checked the school notice clause." },
    });
    expect(
      (within(travel).getByLabelText("Decision reason") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (
        within(travel).getByRole("button", {
          name: "Approve",
          exact: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      within(school).getByRole("button", { name: "Approve", exact: true }),
    );
    await waitFor(() =>
      expect(local.decideObligation).toHaveBeenCalledTimes(1),
    );
    expect(local.decideObligation).toHaveBeenCalledWith(
      source.obligations[0],
      "approve",
      "Checked the school notice clause.",
    );
    expect(
      (within(travel).getByLabelText("Decision reason") as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("keeps a prepared review retryable when the parent agreement refresh fails", async () => {
    const transport = adapter();
    vi.mocked(transport.prepareAgreementReview).mockResolvedValue({
      artifactId: "artifact-1",
      generatedAt: "2026-09-13T00:00:00Z",
      explanation: "Synthetic review successfully persisted.",
      outcome: "no_proposals",
      obligations: [],
    });
    vi.mocked(transport.load)
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("Agreement refresh unavailable"))
      .mockResolvedValue(snapshot());
    render(<FamilyOperationsView adapter={transport} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare review" }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("Agreement refresh unavailable").length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.queryByText("Synthetic review successfully persisted."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prepare review" }));
    await screen.findByText("Synthetic review successfully persisted.");
  });

  it("recovers guest choices from an unavailable permission inventory", async () => {
    const local = adapter();
    local.listGuestAccessOptions = vi
      .fn()
      .mockRejectedValueOnce(new Error("Permission inventory unavailable"))
      .mockResolvedValue(guestOptions());
    render(<FamilyOperationsView adapter={local} />);
    await screen.findByText("Permission inventory unavailable");
    expect(screen.queryByRole("button", { name: "Allow access" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh guest permissions" }),
    );
    await screen.findByLabelText("Verified guest permission");
    expect(screen.queryByText("Permission inventory unavailable")).toBeNull();
  });

  it("rejects an allowed preview for a different permission", async () => {
    const local = adapter();
    const denied = await local.previewGrant({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "grant-1",
    });
    local.previewGrant = async () => ({
      ...denied,
      allowed: true,
      denial: null,
      householdGrantId: "different-permission",
    });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.change(
      await screen.findByLabelText("Verified guest permission"),
      { target: { value: "grant-1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview permission" }));
    await screen.findByText(
      "The permission preview did not match your selection. Refresh guest permissions before continuing.",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Allow access",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(local.issueGrant).not.toHaveBeenCalled();
  });

  it("requires refresh when sharing readback has a different underlying permission", async () => {
    const local = adapter();
    const denied = await local.previewGrant({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "grant-1",
    });
    local.previewGrant = async (input) => ({
      ...denied,
      ...input,
      allowed: true,
      denial: null,
    });
    local.issueGrant = async (input) => ({
      ...input,
      id: "guest-grant-1",
      agentId: "fixture-agent",
      householdId: "default",
      issuedByEntityId: "self",
      revokedAt: null,
      revokedByEntityId: null,
      revocationReason: null,
      createdAt: "2026-09-12T12:00:00Z",
      updatedAt: "2026-09-12T12:00:00Z",
    });
    const wrong = guestOptions();
    wrong.grants[0].householdGrantId = "another-permission";
    local.listGuestAccessOptions = vi
      .fn()
      .mockResolvedValueOnce(guestOptions())
      .mockResolvedValue(wrong);
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.change(
      await screen.findByLabelText("Verified guest permission"),
      { target: { value: "grant-1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview permission" }));
    await screen.findByText("Ready to grant");
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await screen.findByText(
      "Sharing could not be confirmed. Refresh guest permissions before retrying.",
    );
    expect(screen.queryByText("Guest access enabled.")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Preview permission",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("requires a new permission preview after the guest selection changes", async () => {
    const local = adapter();
    const denied = await local.previewGrant({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "grant-1",
    });
    local.previewGrant = async (input) => ({
      ...denied,
      ...input,
      allowed: true,
      denial: null,
    });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.change(
      await screen.findByLabelText("Verified guest permission"),
      { target: { value: "grant-1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview permission" }));
    const issue = screen.getByRole("button", {
      name: "Allow access",
    }) as HTMLButtonElement;
    await waitFor(() => expect(issue.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Verified guest permission"), {
      target: { value: "grant-2" },
    });
    expect(issue.disabled).toBe(true);
  });

  it("disables pinning when destinations fail and recovers on refresh", async () => {
    const local = adapter();
    const available = await local.listPinTargets();
    local.listPinTargets = vi
      .fn()
      .mockRejectedValueOnce(new Error("Conversations are unavailable"))
      .mockResolvedValue(available);
    render(<FamilyOperationsView adapter={local} />);
    await screen.findByText("Conversations are unavailable");
    expect(
      (
        screen.getByRole("button", {
          name: "Pin",
          exact: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh destinations" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Pin",
            exact: true,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText("Conversations are unavailable")).toBeNull();
  });

  it.each([true, false])(
    "confirms a pin only when it can be read back (saved=%s)",
    async (saved) => {
      const local = adapter();
      const pins: Awaited<ReturnType<FamilyOperationsAdapter["listPins"]>> = [];
      local.listPins = async () => pins;
      local.pin = async (input) => {
        const result = {
          ...input,
          id: "confirmed-pin",
          agentId: "fixture-agent",
          pinnedByEntityId: "self",
          pinnedAt: "2026-09-12T12:00:00Z",
          unpinnedAt: null,
        };
        if (saved) pins.push(result);
        return result;
      };
      render(<FamilyOperationsView adapter={local} />);
      const button = await screen.findByRole("button", {
        name: "Pin",
        exact: true,
      });
      await waitFor(() =>
        expect((button as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(button);
      if (saved) {
        await screen.findByText("Pin saved.");
        expect(screen.getByText("This agent: Family assistant")).toBeTruthy();
      } else {
        await screen.findByText(
          "The pin could not be confirmed. Refresh destinations before retrying.",
        );
        expect(screen.queryByText("Pin saved.")).toBeNull();
      }
    },
  );

  it("keeps month intake and packet generation aligned and protects unsaved correspondence", async () => {
    const months: string[] = [];
    const intake: FamilyIntakeAdapter = {
      async decideRequest() {
        throw new Error("Unexpected request decision in this fixture");
      },
      async answerInterview() {
        throw new Error("Interview writes are outside this fixture.");
      },
      async list(period) {
        months.push(period);
        return [];
      },
      async importSource() {
        throw new Error("Import is outside this month-navigation test.");
      },
      async change() {
        throw new Error(
          "Review mutation is outside this month-navigation test.",
        );
      },
      async review() {
        throw new Error(
          "Review mutation is outside this month-navigation test.",
        );
      },
    };
    const local = adapter(pendingEmailSnapshot());
    render(<FamilyOperationsView adapter={local} intakeAdapter={intake} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Monthly packet" }),
    );
    openPacketMonth("2026-10");
    await waitFor(() => expect(months.at(-1)).toBe("2026-10"));
    fireEvent.change(screen.getByLabelText("Email or message text"), {
      target: { value: "Unsaved source stays in October." },
    });
    fireEvent.change(screen.getByLabelText("Month to prepare"), {
      target: { value: "2026-11" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open month", exact: true }),
    );
    expect(screen.getByText(/Opening 2026-11 will discard/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      (screen.getByLabelText("Email or message text") as HTMLTextAreaElement)
        .value,
    ).toBe("Unsaved source stays in October.");
    expect(months.at(-1)).toBe("2026-10");
    expect(
      (screen.getByLabelText("Month to prepare") as HTMLInputElement).value,
    ).toBe("2026-10");
    fireEvent.change(screen.getByLabelText("Month to prepare"), {
      target: { value: "2026-11" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open month", exact: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Discard edits and open month" }),
    );
    await waitFor(() => expect(months.at(-1)).toBe("2026-11"));
    expect(
      (screen.getByLabelText("Email or message text") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(
      screen.queryByRole("button", { name: "Approve and send email" }),
    ).toBeNull();
    const generation = Promise.withResolvers<void>();
    vi.mocked(local.generatePacket).mockReturnValue(generation.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate 2026-11 packet" }),
    );
    expect(local.generatePacket).toHaveBeenCalledWith("2026-11");
    expect(
      (screen.getByLabelText("Month to prepare") as HTMLInputElement).disabled,
    ).toBe(true);
    generation.resolve();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Month to prepare") as HTMLInputElement)
          .disabled,
      ).toBe(false),
    );
    openPacketMonth("2026-10");
    expect(
      await screen.findByRole("button", { name: "Approve and send email" }),
    ).toBeTruthy();
  });

  it("sends the exact reviewed decision once and renders the persisted provider result", async () => {
    const data = pendingEmailSnapshot();
    const local = adapter(data);
    const pending = Promise.withResolvers<void>();
    vi.mocked(local.decidePacketApproval).mockReturnValue(pending.promise);
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Monthly packet" }),
    );
    openPacketMonth("2026-10");
    const approve = screen.getByRole("button", {
      name: "Approve and send email",
    });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(local.decidePacketApproval).toHaveBeenCalledTimes(1);
    expect(local.decidePacketApproval).toHaveBeenCalledWith({
      packetId: "decision-packet",
      draftVersion: 1,
      approvalId: "approval-1",
      bodySha256: "d".repeat(64),
      decision: "approve",
    });
    if (data.packets.status !== "ready")
      throw new Error("Packet fixture unavailable");
    const approval = data.packets.data[0].draft?.approval;
    if (!approval) throw new Error("Approval fixture unavailable");
    approval.state = "done";
    approval.providerAccepted = true;
    approval.providerMessageId = "provider-message";
    pending.resolve();
    await screen.findByText("Accepted by the email provider.");
    expect(
      screen.queryByRole("button", { name: "Approve and send email" }),
    ).toBeNull();
  });

  it("shows an unknown delivery outcome without offering a blind retry", async () => {
    const data = pendingEmailSnapshot();
    const local = adapter(data);
    vi.mocked(local.decidePacketApproval).mockImplementation(async () => {
      if (data.packets.status !== "ready")
        throw new Error("Packet fixture unavailable");
      const approval = data.packets.data[0].draft?.approval;
      if (!approval) throw new Error("Approval fixture unavailable");
      approval.state = "reconciliation_required";
      throw new Error("Delivery acknowledgement was lost.");
    });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Monthly packet" }),
    );
    openPacketMonth("2026-10");
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and send email" }),
    );
    await screen.findByText(
      "Delivery outcome is unknown. Verify the provider record before retrying.",
    );
    expect(
      screen.queryByRole("button", { name: "Approve and send email" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry reviewed email" }),
    ).toBeNull();
    expect(local.decidePacketApproval).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate workspace exports while preparing and restores the control after a denied request", async () => {
    const local = adapter();
    let rejectExport: (error: Error) => void = () => {
      throw new Error("Export has not started");
    };
    local.downloadWorkspace = vi.fn(
      () =>
        new Promise<Blob>((_resolve, reject) => {
          rejectExport = reject;
        }),
    );
    render(<FamilyOperationsView adapter={local} />);
    const button = await screen.findByRole("button", {
      name: "Export workspace",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    const pending = screen.getByRole("button", {
      name: "Preparing workspace export…",
    });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(local.downloadWorkspace).toHaveBeenCalledTimes(1);
    rejectExport(new Error("Owner access is required"));
    expect(await screen.findByText("Owner access is required")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Export workspace",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText("Workspace download started.")).toBeNull();
  });
  it("saves the selected school level and standing update policy before running", async () => {
    const local = adapter();
    const data = await local.load();
    data.school = {
      status: "ready",
      data: {
        monthlySchedule: { status: "ready", data: null },
        sourceId: "concord",
        label: "Concord calendar",
        state: "never_run",
        lastCheckedAt: null,
        sourceUrl:
          "https://www.concordps.org/district-resources/school-year-calendars",
        schoolLevel: "all",
        updateMode: "review",
      },
    };
    local.configureSchool = vi.fn(async () => {
      if (data.school.status !== "ready")
        throw new Error("School state missing");
      data.school.data.monthlySchedule = {
        status: "ready",
        data: {
          taskId: "saved-family-task",
          status: "scheduled",
          lastFiredAt: null,
          trigger: {
            kind: "cron",
            expression: "0 9 1 * *",
            tz: "America/New_York",
          },
        },
      };
    });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "School calendar" }),
    );
    expect(screen.getByText(/Not scheduled yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("School level"), {
      target: { value: "elementary" },
    });
    fireEvent.change(screen.getByLabelText("Calendar updates"), {
      target: { value: "automatic" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save school settings" }),
    );
    await waitFor(() =>
      expect(local.configureSchool).toHaveBeenCalledWith({
        schoolLevel: "elementary",
        updateMode: "automatic",
      }),
    );
    expect(await screen.findByText("Status: Scheduled")).toBeTruthy();
    expect(screen.queryByText(/Not scheduled yet/)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Review scheduled tasks" }),
    ).toBeTruthy();
    expect(local.runSchoolWorkflow).not.toHaveBeenCalled();
  });
  it("edits monthly timing, refreshes persisted state, and keeps failed saves visible", async () => {
    const data = snapshot();
    data.school = {
      status: "ready",
      data: {
        monthlySchedule: { status: "ready", data: null },
        sourceId: "concord",
        label: "Concord calendar",
        state: "never_run",
        lastCheckedAt: null,
        sourceUrl:
          "https://www.concordps.org/district-resources/school-year-calendars",
        schoolLevel: "elementary",
        updateMode: "automatic",
      },
    };
    const schedule = {
      taskId: "monthly-task",
      status: "dismissed" as const,
      lastFiredAt: null,
      trigger: {
        kind: "cron" as const,
        expression: "0 9 1 * *",
        tz: "America/New_York",
      },
    };
    data.school.data.monthlySchedule = { status: "ready", data: schedule };
    const local = adapter(data);
    let fail = false;
    local.updateMonthlySchedule = async (input) => {
      if (fail) throw new Error("Schedule service unavailable");
      const [hour, minute] = input.time.split(":").map(Number);
      schedule.trigger = {
        kind: "cron",
        expression: `${minute} ${hour} ${input.day} * *`,
        tz: input.timezone,
      };
    };
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "School calendar" }),
    );
    fireEvent.change(screen.getByLabelText("Day of month"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Time (America/New_York)"), {
      target: { value: "14:35" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save monthly schedule" }),
    );
    expect(
      await screen.findByText("Monthly on day 15 at 14:35 America/New_York"),
    ).toBeTruthy();
    expect(screen.getByText("Status: Stopped")).toBeTruthy();
    fail = true;
    fireEvent.change(screen.getByLabelText("Day of month"), {
      target: { value: "20" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save monthly schedule" }),
    );
    expect(
      await screen.findByText("Schedule service unavailable"),
    ).toBeTruthy();
    expect(
      screen.getByText("Monthly on day 15 at 14:35 America/New_York"),
    ).toBeTruthy();
    expect(local.runSchoolWorkflow).not.toHaveBeenCalled();
  });
  it("shows export preparation and recovers visibly when the original cannot be verified", async () => {
    const local = adapter();
    let fail: (reason: Error) => void = () => {
      throw new Error("Download has not started");
    };
    local.downloadAgreement = () =>
      new Promise<Blob>((_resolve, reject) => {
        fail = reject;
      });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export agreement" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Preparing export…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fail(new Error("Original failed integrity verification"));
    expect(
      await screen.findByText("Original failed integrity verification"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Export agreement",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("requires a review reason and delegates approval to the canonical adapter", async () => {
    const local = adapter();
    render(<FamilyOperationsView adapter={local} />);
    expect(
      await screen.findByRole("heading", { name: "Family Operations" }),
    ).toBeTruthy();
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Checked against pages 4 and 5." },
    });
    fireEvent.click(approve);
    await waitFor(() =>
      expect(local.decideObligation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "obligation-1" }),
        "approve",
        "Checked against pages 4 and 5.",
      ),
    );
  });

  it("keeps unavailable school APIs visibly distinct from an empty workflow", async () => {
    render(<FamilyOperationsView adapter={adapter()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "School calendar" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "School API is not installed.",
    );
  });

  it("exposes named conflict controls and never includes an expenses section", async () => {
    const local = adapter();
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Calendar sync" }),
    );
    expect(
      await screen.findByRole("heading", { name: "School pickup" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Event school-pickup" }),
    ).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Keep Eliza" }));
    await waitFor(() =>
      expect(local.resolveCalendarConflict).toHaveBeenCalledWith(
        "link-1",
        "keep_eliza",
        "2026-08-30T12:00:00.000Z",
      ),
    );
    expect(screen.queryByRole("button", { name: /expenses/i })).toBeNull();
  });

  it("requires an explicit reason before revoking a guest grant", async () => {
    const local = adapter();
    render(<FamilyOperationsView adapter={local} />);
    const existing = await screen.findByLabelText("Existing guest access");
    expect(screen.queryByRole("button", { name: "Remove access" })).toBeNull();
    fireEvent.change(existing, {
      target: { value: "guest-grant-1" },
    });
    const revoke = await screen.findByRole("button", { name: "Remove access" });
    expect((revoke as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for removing access"), {
      target: { value: "Access is no longer needed." },
    });
    fireEvent.click(revoke);
    await waitFor(() =>
      expect(local.revokeGrant).toHaveBeenCalledWith(
        "guest-grant-1",
        "Access is no longer needed.",
      ),
    );
  });

  it("uploads a signed PDF as an immutable agreement version", async () => {
    const local = adapter({
      ...snapshot(),
      agreements: { status: "ready", data: [] },
    });
    render(<FamilyOperationsView adapter={local} />);
    const file = new File(["%PDF-1.7"], "parenting-plan.pdf", {
      type: "application/pdf",
    });
    fireEvent.click(await screen.findByText("Choose a signed PDF"));
    fireEvent.change(screen.getByLabelText("Signed PDF"), {
      target: { files: [file] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Upload immutable PDF" }),
    );
    await waitFor(() =>
      expect(local.uploadAgreement).toHaveBeenCalledWith(
        expect.objectContaining({
          agreementKey: "parenting-plan",
          title: "Parenting agreement",
          file,
          onProgress: expect.any(Function),
        }),
      ),
    );
  });

  it("clears extraction progress after failure and retries the selected PDF", async () => {
    const local = adapter({
      ...snapshot(),
      agreements: { status: "ready", data: [] },
    });
    const attempt = {
      reject: (_error: Error) => {
        throw new Error("Upload has not started");
      },
    };
    local.uploadAgreement = vi.fn(async ({ onProgress }) => {
      onProgress?.({ uploadedBytes: 8, totalBytes: 8, phase: "processing" });
      await new Promise<void>((_resolve, reject) => {
        attempt.reject = reject;
      });
    });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(await screen.findByText("Choose a signed PDF"));
    fireEvent.change(screen.getByLabelText("Signed PDF"), {
      target: {
        files: [
          new File(["%PDF-1.7"], "retry.pdf", { type: "application/pdf" }),
        ],
      },
    });
    const upload = screen.getByRole("button", { name: "Upload immutable PDF" });
    fireEvent.click(upload);
    await screen.findByText(/Reading every PDF page/);
    attempt.reject(new Error("Extraction unavailable"));
    await screen.findByText("Extraction unavailable");
    expect(screen.queryByText(/Reading every PDF page/)).toBeNull();

    vi.mocked(local.uploadAgreement).mockResolvedValueOnce(undefined);
    fireEvent.click(upload);
    await screen.findByText("Immutable agreement version uploaded.");
    expect(screen.queryByText("Extraction unavailable")).toBeNull();
  });

  it("allows an agreement above the former 20 MiB ceiling", async () => {
    const local = adapter({
      ...snapshot(),
      agreements: { status: "ready", data: [] },
    });
    render(<FamilyOperationsView adapter={local} />);
    const file = new File(["%PDF-1.7"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "size", {
      value: 20 * 1024 * 1024 + 1,
    });
    fireEvent.click(await screen.findByText("Choose a signed PDF"));
    fireEvent.change(screen.getByLabelText("Signed PDF"), {
      target: { files: [file] },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Upload immutable PDF",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Upload immutable PDF" }),
    );
    await waitFor(() => expect(local.uploadAgreement).toHaveBeenCalled());
  });

  it("keeps missing sections distinct from conflicting sources during packet review", async () => {
    const data = snapshot();
    data.packets = {
      status: "ready",
      data: [
        {
          packetId: "review-packet",
          periodKey: "2026-10",
          version: 1,
          createdAt: "2026-09-10T12:00:00Z",
          status: "contradictory",
          sections: [
            {
              section: "school",
              state: "contradictory",
              claimIds: ["school-a", "school-b"],
              contradictoryKeys: ["pickup"],
            },
            {
              section: "approved_obligations",
              state: "missing",
              claimIds: [],
              contradictoryKeys: [],
            },
          ],
          claims: [
            { id: "school-a", section: "school", text: "Pickup is at noon." },
            { id: "school-b", section: "school", text: "Pickup is at 3 PM." },
          ],
        },
      ],
    };
    render(<FamilyOperationsView adapter={adapter(data)} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Monthly packet" }),
    );
    openPacketMonth("2026-10");
    const conflict = screen.getByRole("region", { name: "School review" });
    expect(within(conflict).getByText("Pickup is at noon.")).toBeTruthy();
    expect(within(conflict).getByText("Pickup is at 3 PM.")).toBeTruthy();
    const missing = screen.getByRole("region", {
      name: "Agreement obligations review",
    });
    expect(
      within(missing).getByText(/No source material is recorded/),
    ).toBeTruthy();
    expect(within(missing).queryByText(/These sources disagree/)).toBeNull();
    expect(screen.getAllByText("Pickup is at noon.")).toHaveLength(1);
  });

  it("creates, reviews, and requests approval for an immutable packet draft", async () => {
    const data = snapshot();
    data.packets = {
      status: "ready",
      data: [
        {
          packetId: "packet/1",
          periodKey: "2026-08",
          version: 1,
          createdAt: "2026-08-30T12:00:00.000Z",
          status: "complete",
          sections: [],
          claims: [
            { id: "claim-1", section: "school", text: "No school." },
            {
              id: "private-claim",
              section: "travel_consent_health",
              text: "Private owner note omitted by the disclosure policy.",
            },
          ],
          draft: {
            draftVersion: 2,
            bodySha256: "d".repeat(64),
            approval: null,
            recipient: "guest@example.com",
            recipientEntityId: "guest-1",
            calendarPrivacyMode: "busy_only",
            body: "Family coordination\n\n## school\n- No school.",
            email: { subject: "Monthly plans", senderGrantId: "sender-1" },
          },
        },
      ],
    };
    const local = adapter(data);
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Monthly packet" }),
    );
    openPacketMonth("2026-08");
    const download = screen
      .getByRole("link", {
        name: "Download draft record",
      })
      .getAttribute("href");
    if (!download) throw new Error("Draft download has no payload");
    const record = JSON.parse(decodeURIComponent(download.split(",")[1]));
    expect(record.draft.body).toBe(data.packets.data[0].draft?.body);
    expect(JSON.stringify(record)).not.toContain("Private owner note");
    fireEvent.change(screen.getByLabelText("Sending account"), {
      target: { value: "sender-1" },
    });
    fireEvent.change(screen.getByLabelText("Email recipient"), {
      target: { value: JSON.stringify(["guest-1", "guest@example.com"]) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create privacy-filtered draft" }),
    );
    await waitFor(() =>
      expect(local.createPacketDraft).toHaveBeenCalledWith({
        packetId: "packet/1",
        expectedPacketVersion: 1,
        recipient: "guest@example.com",
        recipientEntityId: "guest-1",
        calendarPrivacyMode: "busy_only",
        email: { subject: expect.any(String), senderGrantId: "sender-1" },
      }),
    );
    expect(screen.getByText(/Family coordination/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Request owner approval" }),
    );
    await waitFor(() =>
      expect(local.requestPacketApproval).toHaveBeenCalledWith("packet/1", 2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit email draft" }));
    fireEvent.change(screen.getByLabelText("Email text"), {
      target: { value: "Please confirm pickup at 3 PM." },
    });
    fireEvent.change(
      within(
        screen.getByRole("group", { name: "Edit saved email" }),
      ).getByLabelText("Email subject"),
      {
        target: { value: "Updated monthly plans" },
      },
    );
    expect(
      screen.queryByRole("button", { name: "Request owner approval" }),
    ).toBeNull();
    const saved = data.packets.data[0].draft;
    if (!saved) throw new Error("Fixture omitted saved draft");
    vi.mocked(local.load).mockResolvedValue({
      ...data,
      packets: {
        status: "ready",
        data: [
          {
            ...data.packets.data[0],
            draft: {
              ...saved,
              draftVersion: 3,
              body: "Please confirm pickup at 3 PM.",
              email: {
                subject: "Updated monthly plans",
                senderGrantId: "sender-1",
              },
            },
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new draft" }));
    await waitFor(() =>
      expect(local.revisePacketDraft).toHaveBeenCalledWith({
        packetId: "packet/1",
        expectedDraftVersion: 2,
        subject: "Updated monthly plans",
        body: "Please confirm pickup at 3 PM.",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Request owner approval" }),
    );
    await waitFor(() =>
      expect(local.requestPacketApproval).toHaveBeenLastCalledWith(
        "packet/1",
        3,
      ),
    );
  });
});
