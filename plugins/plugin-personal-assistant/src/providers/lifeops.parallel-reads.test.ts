/**
 * The `lifeops` provider fans its independent owner/connector reads out with
 * `Promise.all` instead of awaiting them one after another (0.55-1.1 s of
 * serial round trips per planner recompose, live 2026-09-13). This suite pins
 * that contract: every independent read is issued before any of them
 * resolves; the rendered block is identical whether the reads settle in
 * program order (the previous sequential behaviour) or in reverse; the
 * overview -> completed-today and connector-status -> calendar/gmail orderings
 * survive; and each read keeps its original failure semantics. Runtime,
 * service, owner readers, and the account manager are controlled
 * collaborators; Date is pinned so relative-time lines stay deterministic.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsGmailTriageSummary,
  LifeOpsGoogleConnectorStatus,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
} from "../contracts/index.js";
import type {
  ConnectorContribution,
  ConnectorStatus,
} from "../lifeops/connectors/contract.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../lifeops/connectors/registry.js";
import type { OwnerFacts } from "../lifeops/owner/fact-store.js";
import type { LifeOpsOwnerProfile } from "../lifeops/owner-profile.js";
import { lifeOpsProvider } from "./lifeops.js";

const ids = vi.hoisted(() => ({
  agentId: "00000000-0000-0000-0000-000000000004",
  ownerId: "00000000-0000-0000-0000-000000000001",
  roomId: "00000000-0000-0000-0000-000000000009",
}));

const reads = vi.hoisted(() => ({
  hasLifeOpsAccess: vi.fn(),
  readOwnerProfile: vi.fn(),
  readOwnerFacts: vi.fn(),
  getOverview: vi.fn(),
  listCompletedToday: vi.fn(),
  listAccounts: vi.fn(),
  listConnectorAccountPrivacy: vi.fn(),
  getGoogleConnectorAccounts: vi.fn(),
  connectorStatus: vi.fn(),
  getNextCalendarEventContext: vi.fn(),
  getGmailTriage: vi.fn(),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    // The delivery-audience gate has its own coverage (plugin.test.ts and
    // core); this suite exercises the read fan-out behind an attested owner
    // turn, so the gate is held open.
    evaluateOwnerExclusiveDisclosure: () => ({ allowed: true }),
    getConnectorAccountManager: () => ({ listAccounts: reads.listAccounts }),
  };
});

vi.mock("../lifeops/access.js", () => ({
  hasLifeOpsAccess: reads.hasLifeOpsAccess,
}));

vi.mock("../lifeops/owner-profile.js", () => ({
  readLifeOpsOwnerProfile: reads.readOwnerProfile,
}));

vi.mock("../lifeops/owner/fact-store.js", () => ({
  resolveOwnerFactStore: () => ({ read: reads.readOwnerFacts }),
}));

vi.mock("../lifeops/service.js", () => {
  class LifeOpsService {
    readonly repository = {
      listConnectorAccountPrivacy: reads.listConnectorAccountPrivacy,
    };

    agentId(): string {
      return ids.agentId;
    }

    getOverview() {
      return reads.getOverview();
    }

    listOwnerOccurrencesCompletedToday(now: Date) {
      return reads.listCompletedToday(now);
    }

    getGoogleConnectorAccounts(requestUrl: URL) {
      return reads.getGoogleConnectorAccounts(requestUrl);
    }

    getNextCalendarEventContext(requestUrl: URL) {
      return reads.getNextCalendarEventContext(requestUrl);
    }

    getGmailTriage(requestUrl: URL, request: unknown) {
      return reads.getGmailTriage(requestUrl, request);
    }
  }
  return { LifeOpsService };
});

const FAKE_NOW = new Date("2026-09-13T15:00:00.000Z");
const provenance = {
  source: "first_run",
  recordedAt: "2026-09-01T00:00:00.000Z",
} as const;

const fixture = {
  ownerProfile: {
    name: "Ada",
    relationshipStatus: "married",
    partnerName: "Bo",
    orientation: "n/a",
    gender: "n/a",
    age: "41",
    location: "Lisbon",
    travelBookingPreferences: "aisle seat",
    updatedAt: null,
  } as unknown as LifeOpsOwnerProfile,
  ownerFacts: {
    timezone: { value: "Europe/Lisbon", provenance },
    quietHours: {
      value: {
        startLocal: "23:00",
        endLocal: "07:00",
        timezone: "Europe/Lisbon",
      },
      provenance,
    },
  } as unknown as OwnerFacts,
  overview: {
    owner: {
      occurrences: [
        { title: "Stretch", state: "pending", progress: null },
        {
          title: "Water",
          state: "pending",
          progress: {
            completedCount: 3,
            targetCount: 8,
            remainingCount: 5,
            unit: "cup",
          },
        },
      ],
      goals: [
        {
          id: "g1",
          title: "Ship the audit",
          status: "active",
          reviewState: "on_track",
          updatedAt: "2026-09-12T10:00:00.000Z",
          metadata: {
            computedGoalReview: { reviewedAt: "2026-09-13T13:00:00.000Z" },
          },
        },
        {
          id: "g2",
          title: "Read more",
          status: "active",
          reviewState: "needs_review",
          updatedAt: "2026-09-10T10:00:00.000Z",
          metadata: {},
        },
        {
          id: "g3",
          title: "Learn Rust",
          status: "archived",
          reviewState: "on_track",
          updatedAt: "2026-08-01T10:00:00.000Z",
          metadata: {},
        },
      ],
      summary: {
        activeOccurrenceCount: 2,
        activeGoalCount: 2,
        activeReminderCount: 1,
      },
    },
    agentOps: {
      occurrences: [
        { title: "Rotate logs", state: "scheduled", progress: null },
      ],
      goals: [],
      summary: {
        activeOccurrenceCount: 1,
        activeGoalCount: 0,
        activeReminderCount: 0,
      },
    },
  } as unknown as LifeOpsOverview,
  completedToday: [
    { title: "Morning run", updatedAt: "2026-09-13T07:30:00.000Z" },
  ] as unknown as LifeOpsOccurrenceView[],
  connectorAccounts: [
    {
      id: "acct-1",
      provider: "google",
      externalId: "ext-1",
      status: "connected",
      metadata: { email: "ada@example.com", privacy: "owner_only" },
    },
    {
      id: "acct-2",
      provider: "google",
      externalId: "ext-2",
      status: "connected",
      metadata: { email: "ada.work@example.com", privacy: "owner_only" },
    },
  ],
  googleAccounts: [
    {
      connected: true,
      grant: { connectorAccountId: "acct-1" },
      identity: { email: "ada@example.com" },
      grantedCapabilities: ["google.calendar.read", "google.gmail.triage"],
    },
    {
      connected: true,
      grant: { connectorAccountId: "acct-2" },
      identity: { email: "ada.work@example.com" },
      grantedCapabilities: ["google.calendar.read"],
    },
  ] as unknown as LifeOpsGoogleConnectorStatus[],
  connectorStatus: {
    state: "degraded",
    message: "token expiring",
    observedAt: "2026-09-13T15:00:00.000Z",
  } as ConnectorStatus,
  nextEvent: {
    event: { title: "Standup" },
    startsInMinutes: 30,
    attendeeNames: ["Bo"],
    location: "Zoom",
  } as unknown as LifeOpsNextCalendarEventContext,
  gmailSummary: {
    unreadCount: 4,
    importantNewCount: 1,
    likelyReplyNeededCount: 2,
  } as unknown as LifeOpsGmailTriageSummary,
};

// What the serial provider rendered for this fixture, from the first owner
// line to the end of the block (the routing preamble above it is static).
const EXPECTED_DYNAMIC_LINES = [
  "Owner profile: name=Ada | relationship=married | partner=Bo | orientation=n/a | gender=n/a | age=41 | location=Lisbon | travelPrefs=aisle seat",
  "Owner timing facts: timezone=Europe/Lisbon | protected quiet/sleep window=23:00-07:00 Europe/Lisbon",
  "Calendar creates inside the protected quiet/sleep window are conflicts: do not book silently; ask for explicit owner override and propose alternatives outside the protected window.",
  "Owner open occurrences: 2",
  "Owner active goals: 2",
  "- Ship the audit (on_track, last reviewed 2h ago)",
  "- Read more (needs_review, review pending)",
  "Owner live reminders: 1",
  "Owner completed today: 1",
  "Owner completed today:",
  "- Morning run (completed)",
  "Owner active items:",
  "- Stretch (pending)",
  "- Water (3/8 cups; 5 remaining)",
  "Available Google accounts:",
  "- ada@example.com (connectorAccountId: acct-1)",
  "- ada.work@example.com (connectorAccountId: acct-2)",
  "Next event: Standup (30m)",
  "  With: Bo",
  "  At: Zoom",
  "Inbox: 4 unread, 1 important, 2 needing reply",
  "Connector Google (Gmail + Calendar) degraded: token expiring",
  "Agent open occurrences: 1",
  "Agent active goals: 0",
  "Agent ops:",
  "- Rotate logs (scheduled)",
];

const EXPECTED_VALUES = {
  ownerOpenOccurrences: 2,
  ownerCompletedToday: 1,
  ownerActiveGoals: 2,
  ownerActiveGoalTitles: ["Ship the audit", "Read more"],
  ownerProfileName: "Ada",
  ownerRelationshipStatus: "married",
  ownerPartnerName: "Bo",
  ownerOrientation: "n/a",
  ownerGender: "n/a",
  ownerAge: "41",
  ownerLocation: "Lisbon",
  agentOpenOccurrences: 1,
  agentActiveGoals: 0,
};

const message = {
  id: "00000000-0000-0000-0000-0000000000a1",
  entityId: ids.ownerId,
  agentId: ids.agentId,
  roomId: ids.roomId,
  content: { text: "what's on my calendar today?" },
} as unknown as Memory;
const state: State = { text: "", values: {}, data: {} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain every pending microtask (Date is the only faked timer). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createRuntime(): IAgentRuntime {
  const runtime = {
    agentId: ids.agentId,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const registry = createConnectorRegistry();
  registry.register({
    kind: "google",
    capabilities: [],
    modes: ["local"],
    describe: { label: "Google (Gmail + Calendar)" },
    status: () => reads.connectorStatus(),
  } as unknown as ConnectorContribution);
  registerConnectorRegistry(runtime, registry);
  return runtime;
}

function reportedScopes(runtime: IAgentRuntime): string[] {
  return (runtime.reportError as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => String(call[0]),
  );
}

function dynamicLines(text: string | undefined): string[] {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("Owner profile:"));
  expect(start).toBeGreaterThan(0);
  return lines.slice(start);
}

function resetReads(): void {
  for (const read of Object.values(reads)) read.mockReset();
}

/** Every read answers at once: the resolution order the serial version saw. */
function wireImmediate(): void {
  reads.hasLifeOpsAccess.mockResolvedValue(true);
  reads.readOwnerProfile.mockResolvedValue(fixture.ownerProfile);
  reads.readOwnerFacts.mockResolvedValue(fixture.ownerFacts);
  reads.getOverview.mockResolvedValue(fixture.overview);
  reads.listCompletedToday.mockResolvedValue(fixture.completedToday);
  reads.listAccounts.mockResolvedValue(fixture.connectorAccounts);
  reads.listConnectorAccountPrivacy.mockResolvedValue([]);
  reads.getGoogleConnectorAccounts.mockResolvedValue(fixture.googleAccounts);
  reads.connectorStatus.mockResolvedValue(fixture.connectorStatus);
  reads.getNextCalendarEventContext.mockResolvedValue(fixture.nextEvent);
  reads.getGmailTriage.mockResolvedValue({ summary: fixture.gmailSummary });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FAKE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetReads();
});

describe("lifeops provider read fan-out", () => {
  it("renders the serial fixture block when every read answers in program order", async () => {
    wireImmediate();
    const runtime = createRuntime();

    const result = await lifeOpsProvider.get(runtime, message, state);

    expect(dynamicLines(result.text)).toEqual(EXPECTED_DYNAMIC_LINES);
    expect(result.values).toEqual(EXPECTED_VALUES);
    expect(result.data?.ownerProfile).toEqual(fixture.ownerProfile);
    expect(result.data?.nextEventContext).toEqual(fixture.nextEvent);
    expect(result.data?.gmailSummary).toEqual(fixture.gmailSummary);
    expect(reads.listCompletedToday).toHaveBeenCalledWith(FAKE_NOW);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("issues every independent read before any resolves, keeps the dependent reads ordered, and renders the same block in reverse resolution order", async () => {
    wireImmediate();
    const serial = await lifeOpsProvider.get(createRuntime(), message, state);
    resetReads();

    const gates = {
      profile: deferred<LifeOpsOwnerProfile>(),
      facts: deferred<OwnerFacts>(),
      overview: deferred<LifeOpsOverview>(),
      completed: deferred<LifeOpsOccurrenceView[]>(),
      accounts: deferred<unknown[]>(),
      privacy: deferred<unknown[]>(),
      google: deferred<LifeOpsGoogleConnectorStatus[]>(),
      status: deferred<ConnectorStatus>(),
    };
    reads.hasLifeOpsAccess.mockResolvedValue(true);
    reads.readOwnerProfile.mockReturnValue(gates.profile.promise);
    reads.readOwnerFacts.mockReturnValue(gates.facts.promise);
    reads.getOverview.mockReturnValue(gates.overview.promise);
    reads.listCompletedToday.mockReturnValue(gates.completed.promise);
    reads.listAccounts.mockReturnValue(gates.accounts.promise);
    reads.listConnectorAccountPrivacy.mockReturnValue(gates.privacy.promise);
    reads.getGoogleConnectorAccounts.mockReturnValue(gates.google.promise);
    reads.connectorStatus.mockReturnValue(gates.status.promise);
    reads.getNextCalendarEventContext.mockResolvedValue(fixture.nextEvent);
    reads.getGmailTriage.mockResolvedValue({ summary: fixture.gmailSummary });
    const runtime = createRuntime();

    const pending = lifeOpsProvider.get(runtime, message, state);
    await flush();

    // All seven independent reads are in flight while none has resolved. The
    // serial version had issued exactly one at this point.
    expect(reads.readOwnerProfile).toHaveBeenCalledTimes(1);
    expect(reads.readOwnerFacts).toHaveBeenCalledTimes(1);
    expect(reads.getOverview).toHaveBeenCalledTimes(1);
    expect(reads.listAccounts).toHaveBeenCalledWith("google");
    expect(reads.listConnectorAccountPrivacy).toHaveBeenCalledWith(ids.agentId);
    expect(reads.getGoogleConnectorAccounts).toHaveBeenCalledTimes(1);
    expect(reads.connectorStatus).toHaveBeenCalledTimes(1);
    // Ordered reads are still gated on what they depend on.
    expect(reads.listCompletedToday).not.toHaveBeenCalled();
    expect(reads.getNextCalendarEventContext).not.toHaveBeenCalled();
    expect(reads.getGmailTriage).not.toHaveBeenCalled();

    // Resolve in reverse program order.
    gates.status.resolve(fixture.connectorStatus);
    gates.google.resolve(fixture.googleAccounts);
    gates.privacy.resolve([]);
    gates.accounts.resolve(fixture.connectorAccounts);
    gates.overview.resolve(fixture.overview);
    await flush();

    // completed-today follows the overview refresh; calendar/gmail still wait
    // for the whole group.
    expect(reads.listCompletedToday).toHaveBeenCalledTimes(1);
    expect(reads.listCompletedToday).toHaveBeenCalledWith(FAKE_NOW);
    expect(reads.getNextCalendarEventContext).not.toHaveBeenCalled();
    expect(reads.getGmailTriage).not.toHaveBeenCalled();

    gates.completed.resolve(fixture.completedToday);
    gates.facts.resolve(fixture.ownerFacts);
    gates.profile.resolve(fixture.ownerProfile);
    const concurrent = await pending;

    expect(reads.getNextCalendarEventContext).toHaveBeenCalledTimes(1);
    expect(reads.getGmailTriage).toHaveBeenCalledTimes(1);
    expect(concurrent).toEqual(serial);
    expect(dynamicLines(concurrent.text)).toEqual(EXPECTED_DYNAMIC_LINES);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("keeps the connector-account read fatal: a rejection renders the unavailable block", async () => {
    wireImmediate();
    reads.listAccounts.mockRejectedValue(new Error("pg down"));
    const runtime = createRuntime();

    const result = await lifeOpsProvider.get(runtime, message, state);

    expect(result.text).toBe("LifeOps overview unavailable.");
    expect(result.values).toEqual({ lifeOpsOverviewUnavailable: true });
    expect(result.data).toEqual({
      error: "Google connector account read failed.",
    });
    expect(reportedScopes(runtime)).toEqual([
      "LifeOpsProvider.connectorAccounts",
      "LifeOpsProvider.get",
    ]);
  });

  it("keeps the privacy-policy read fail-closed: a rejection degrades in place and the block still renders", async () => {
    wireImmediate();
    reads.listConnectorAccountPrivacy.mockRejectedValue(
      new Error("table missing"),
    );
    const runtime = createRuntime();

    const result = await lifeOpsProvider.get(runtime, message, state);

    expect(dynamicLines(result.text)).toEqual(EXPECTED_DYNAMIC_LINES);
    expect(result.values).toEqual(EXPECTED_VALUES);
    expect(reportedScopes(runtime)).toEqual(["LifeOpsProvider.accountPrivacy"]);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "LifeOpsProvider.accountPrivacy",
      expect.any(Error),
      { agentId: ids.agentId },
    );
  });

  it("keeps the Google connector read degradable: a rejection renders the status line and skips the calendar/gmail branch", async () => {
    wireImmediate();
    reads.getGoogleConnectorAccounts.mockRejectedValue(
      new Error("oauth offline"),
    );
    const runtime = createRuntime();

    const result = await lifeOpsProvider.get(runtime, message, state);

    const lines = dynamicLines(result.text);
    expect(lines).toContain(
      "Google connector status unavailable: oauth offline",
    );
    expect(lines).toContain(
      "Connector Google (Gmail + Calendar) degraded: token expiring",
    );
    expect(lines).not.toContain("Next event: Standup (30m)");
    expect(lines).not.toContain(
      "Inbox: 4 unread, 1 important, 2 needing reply",
    );
    expect(reads.getNextCalendarEventContext).not.toHaveBeenCalled();
    expect(reads.getGmailTriage).not.toHaveBeenCalled();
    expect(result.values).toEqual(EXPECTED_VALUES);
    expect(result.data?.nextEventContext).toBeNull();
    expect(result.data?.gmailSummary).toBeNull();
    expect(reportedScopes(runtime)).toEqual([
      "LifeOpsProvider.googleConnector",
    ]);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "LifeOpsProvider.googleConnector",
      expect.any(Error),
      { roomId: ids.roomId },
    );
  });

  it("keeps the overview read fatal and never issues the completed-today read behind it", async () => {
    wireImmediate();
    reads.getOverview.mockRejectedValue(new Error("overview exploded"));
    const runtime = createRuntime();

    const result = await lifeOpsProvider.get(runtime, message, state);

    expect(result.text).toBe("LifeOps overview unavailable.");
    expect(result.values).toEqual({ lifeOpsOverviewUnavailable: true });
    expect(result.data).toEqual({ error: "overview exploded" });
    expect(reads.listCompletedToday).not.toHaveBeenCalled();
    expect(reportedScopes(runtime)).toEqual(["LifeOpsProvider.get"]);
  });

  it("keeps a throwing connector status probe degradable inside the group", async () => {
    wireImmediate();
    reads.connectorStatus.mockRejectedValue(new Error("probe timeout"));
    const runtime = createRuntime();

    const result = await lifeOpsProvider.get(runtime, message, state);

    expect(dynamicLines(result.text)).toContain(
      "Connector Google (Gmail + Calendar) disconnected: probe timeout",
    );
    expect(result.values).toEqual(EXPECTED_VALUES);
    expect(reportedScopes(runtime)).toEqual([
      "LifeOpsProvider.connectorStatus",
    ]);
  });

  it("issues no reads when the owner gate denies the turn", async () => {
    wireImmediate();
    reads.hasLifeOpsAccess.mockResolvedValue(false);

    const result = await lifeOpsProvider.get(createRuntime(), message, state);

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(reads.readOwnerProfile).not.toHaveBeenCalled();
    expect(reads.readOwnerFacts).not.toHaveBeenCalled();
    expect(reads.getOverview).not.toHaveBeenCalled();
    expect(reads.listAccounts).not.toHaveBeenCalled();
    expect(reads.listConnectorAccountPrivacy).not.toHaveBeenCalled();
    expect(reads.getGoogleConnectorAccounts).not.toHaveBeenCalled();
    expect(reads.connectorStatus).not.toHaveBeenCalled();
  });
});
