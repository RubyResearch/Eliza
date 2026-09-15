// @vitest-environment jsdom

/**
 * Deterministic first-five-minutes and recovery tests for the LifeOps
 * connection manager. The injected adapter is local-only: no OAuth flow,
 * provider mutation, native permission prompt, or network request can run.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountHandoffRecord } from "../../lifeops/account-handoff-store.js";
import type { AccountHandoffAdapter } from "./handoff-adapter.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
} from "./types.js";

vi.mock("./adapter.js", () => ({
  defaultLifeOpsConnectionsAdapter: {},
}));

import {
  retireReplacedAccount,
  reviewAccountTransition,
} from "./account-transition.js";
import { LifeOpsConnectionsView } from "./LifeOpsConnectionsView.js";

// jsdom has no layout scroll implementation; the browser suite verifies visibility.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const GRANT_ID = "connector-account:account-1";
const CONNECTOR_ACCOUNT_ID = "account-1";

function grant(): LifeOpsConnectorGrant {
  return {
    id: GRANT_ID,
    agentId: "agent-1",
    provider: "google",
    connectorAccountId: CONNECTOR_ACCOUNT_ID,
    side: "owner",
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    capabilities: [
      "google.gmail.triage",
      "google.gmail.compose",
      "google.calendar.read",
    ],
    tokenRef: "protected:test-reference",
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: "2026-08-22T08:00:00.000Z",
    createdAt: "2026-08-22T07:00:00.000Z",
    updatedAt: "2026-08-22T08:00:00.000Z",
  };
}

function googleStatus(): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    configured: true,
    connected: true,
    reason: "connected",
    preferredByAgent: true,
    cloudConnectionId: null,
    identity: { email: "owner@example.test" },
    grantedCapabilities: [
      "google.gmail.triage",
      "google.gmail.compose",
      "google.calendar.read",
    ],
    grantedScopes: grant().grantedScopes,
    expiresAt: "2026-08-22T10:00:00.000Z",
    hasRefreshToken: true,
    grant: grant(),
  };
}

function secondGoogleStatus(): LifeOpsGoogleConnectorStatus {
  const first = googleStatus();
  const secondGrantId = "connector-account:account-2";
  return {
    ...first,
    identity: { email: "second@example.test" },
    grant: first.grant
      ? {
          ...first.grant,
          id: secondGrantId,
          connectorAccountId: "account-2",
          identity: { email: "second@example.test" },
          identityEmail: "second@example.test",
        }
      : null,
  };
}

function calendar(
  provider: "google" | "apple_calendar",
): LifeOpsCalendarSummary {
  const isGoogle = provider === "google";
  return {
    provider,
    side: "owner",
    grantId: isGoogle ? GRANT_ID : "apple-calendar",
    connectorAccountId: isGoogle ? CONNECTOR_ACCOUNT_ID : "apple-calendar",
    accountEmail: isGoogle ? "owner@example.test" : null,
    calendarId: isGoogle ? "primary" : "apple-personal",
    summary: isGoogle ? "Google primary" : "Apple personal",
    description: null,
    primary: true,
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
    selectionVersion: 3,
  };
}

function source(
  calendarSummary: LifeOpsCalendarSummary,
  overrides: Partial<LifeOpsCalendarSourceHealth> = {},
): LifeOpsCalendarSourceHealth {
  return {
    key: {
      provider: calendarSummary.provider,
      side: calendarSummary.side,
      grantId: calendarSummary.grantId,
      connectorAccountId: calendarSummary.connectorAccountId,
      calendarId: calendarSummary.calendarId,
    },
    summary: calendarSummary.summary,
    accessRole: calendarSummary.accessRole,
    visibility: "details",
    status: "fresh",
    syncedAt: "2026-08-22T08:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function snapshot(): LifeOpsConnectionsSnapshot {
  const google = calendar("google");
  const apple = calendar("apple_calendar");
  return {
    googleAccounts: [googleStatus()],
    calendars: [google, apple],
    calendarFeed: {
      calendarId: "all",
      events: [],
      source: "cache",
      state: "partial",
      sources: [
        source(google, {
          status: "stale",
          error: {
            code: "RATE_LIMITED",
            message: "Google Calendar retry is pending.",
            retryable: true,
          },
          changeDelivery: {
            mode: "polling",
            status: "degraded",
            expiresAt: null,
            lastNotificationAt: null,
            lastSuccessfulSyncAt: "2026-08-22T08:00:00.000Z",
            error: null,
          },
        }),
        source(apple),
      ],
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      syncedAt: "2026-08-22T08:00:00.000Z",
    },
    gmailHealthByGrantId: {
      [GRANT_ID]: {
        provider: "google",
        side: "owner",
        grantId: GRANT_ID,
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        mailbox: "me",
        state: "current",
        cursorStatus: "incremental",
        historyCursorPresent: true,
        fullResyncReason: null,
        cachedMessageCount: 12,
        syncedAt: "2026-08-22T08:00:00.000Z",
      },
    },
    applePermission: {
      id: "calendar",
      status: "denied",
      lastChecked: Date.parse("2026-08-22T08:00:00.000Z"),
      canRequest: false,
      platform: "darwin",
      reason: "Allow Calendar access in System Settings.",
    },
    observedAt: "2026-08-22T08:00:00.000Z",
  };
}

function adapter(): LifeOpsConnectionsAdapter {
  return {
    getLinkedCalendarControl: vi.fn(async () => ({
      revision: 0,
      paused: true,
      destination: null,
      pendingDispatch: null,
    })),
    updateLinkedCalendarControl: vi.fn(async () => {
      throw new Error("Sync mutation must be configured by this test.");
    }),
    load: vi.fn(async () => snapshot()),
    connectGoogle: vi.fn(async () => undefined),
    disconnectGoogle: vi.fn(async () => undefined),
    setCalendarIncluded: vi.fn(async (item, includeInFeed) => ({
      ...item,
      includeInFeed,
      selectionVersion: item.selectionVersion + 1,
    })),
    seed: vi.fn(async (request, onProgress) => {
      onProgress("preparing");
      onProgress("gmail");
      onProgress("calendar");
      onProgress("deduplicating");
      onProgress("complete");
      return {
        grantId: request.grantId,
        rangeDays: request.rangeDays,
        gmailMessageCount: 12,
        calendarEventCount: 8,
        calendarSourceCount: request.calendarKeys.length,
        duplicateEventCount: 1,
        completedAt: "2026-08-22T09:00:00.000Z",
      };
    }),
    purgeImportedData: vi.fn(async ({ grantId, includeGmail, calendars }) => ({
      gmail: includeGmail
        ? {
            provider: "google",
            side: "owner",
            grantId,
            connectorAccountId: CONNECTOR_ACCOUNT_ID,
            deletedMessageCount: 12,
            deletedSpamReviewCount: 1,
            deletedSyncCursor: true,
            providerMutation: false,
            purgedAt: "2026-08-22T09:00:00.000Z",
          }
        : null,
      calendars: calendars.map((item) => ({
        provider: item.provider as "google" | "apple_calendar",
        side: item.side,
        grantId: item.grantId,
        connectorAccountId: item.connectorAccountId,
        deletedEventCount: 4,
        deletedSyncStateCount: 1,
        providerMutation: false,
        purgedAt: "2026-08-22T09:00:00.000Z",
      })),
    })),
    requestApplePermission: vi.fn(async () => ({
      id: "calendar",
      status: "granted",
      lastChecked: Date.now(),
      canRequest: false,
      platform: "darwin",
    })),
    openApplePermissionSettings: vi.fn(async () => undefined),
    navigate: vi.fn(),
  };
}

afterEach(cleanup);

describe("LifeOpsConnectionsView", () => {
  it("turns an offline load failure into an actionable retry state", async () => {
    const localAdapter = adapter();
    localAdapter.load = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    render(<LifeOpsConnectionsView adapter={localAdapter} />);

    expect(
      await screen.findByText(
        "Eliza is offline or its local service is unavailable. Restart Eliza if needed, then retry.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("explains scopes and renders partial, permission, provenance, and cursor states", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);

    expect(await screen.findByText("owner@example.test")).toBeTruthy();
    expect(screen.getByText(/Some calendar sources failed/)).toBeTruthy();
    expect(screen.getByText(/History cursor: incremental/)).toBeTruthy();
    expect(screen.getByText(/retry is pending/)).toBeTruthy();
    expect(screen.getByText("Permission denied")).toBeTruthy();
    expect(
      screen.getByText(/Title and time alone are never used/),
    ).toBeTruthy();

    expect(
      (
        screen.getByRole("checkbox", {
          name: /Read and search Gmail/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Send approved email/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Open System Settings" }),
    );
    expect(localAdapter.openApplePermissionSettings).toHaveBeenCalledOnce();
  });

  it("seeds a bounded cross-provider selection and shows real phase counts", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    const sevenDays = screen.getByRole("button", { name: "7 days" });
    fireEvent.click(sevenDays);
    expect(sevenDays.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Seed selected context" }),
    );

    await waitFor(() => expect(localAdapter.seed).toHaveBeenCalledOnce());
    expect(localAdapter.seed).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: GRANT_ID,
        rangeDays: 7,
        includeGmail: true,
        calendarKeys: expect.arrayContaining([
          expect.stringContaining("google"),
          expect.stringContaining("apple_calendar"),
        ]),
      }),
      expect.any(Function),
    );
    expect((await screen.findByTestId("seed-receipt")).textContent).toContain(
      "12 Gmail messages and 8 calendar events from 2 sources. 1 duplicate delivery ignored.",
    );
  });

  it("keeps disconnect and local purge separate and confirms exact identity", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    fireEvent.click(
      screen.getByRole("button", { name: /Purge imported Google data/ }),
    );
    expect(localAdapter.purgeImportedData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm purge" }));

    await waitFor(() =>
      expect(localAdapter.purgeImportedData).toHaveBeenCalledWith(
        expect.objectContaining({
          grantId: GRANT_ID,
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          includeGmail: true,
        }),
      ),
    );
    expect((await screen.findByTestId("purge-receipt")).textContent).toContain(
      "Providers were not changed",
    );
    expect(localAdapter.disconnectGoogle).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /Disconnect Google account/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() =>
      expect(localAdapter.disconnectGoogle).toHaveBeenCalledWith(GRANT_ID),
    );
  });

  it("seeds only the active Google account plus selected Apple calendars", async () => {
    const localAdapter = adapter();
    const firstSnapshot = snapshot();
    const secondCalendar: LifeOpsCalendarSummary = {
      ...calendar("google"),
      grantId: "connector-account:account-2",
      connectorAccountId: "account-2",
      accountEmail: "second@example.test",
      calendarId: "second-primary",
      summary: "Second primary",
    };
    vi.mocked(localAdapter.load).mockResolvedValue({
      ...firstSnapshot,
      googleAccounts: [googleStatus(), secondGoogleStatus()],
      calendars: [...firstSnapshot.calendars, secondCalendar],
    });
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    fireEvent.change(
      screen.getByRole("combobox", { name: "Active Google account" }),
      { target: { value: "connector-account:account-2" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Seed selected context" }),
    );

    await waitFor(() => expect(localAdapter.seed).toHaveBeenCalledOnce());
    const request = vi.mocked(localAdapter.seed).mock.calls[0]?.[0];
    expect(request?.grantId).toBe("connector-account:account-2");
    expect(request?.calendarKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining("second-primary"),
        expect.stringContaining("apple-personal"),
      ]),
    );
    expect(request?.calendarKeys).not.toContain(
      JSON.stringify([
        "google",
        "owner",
        GRANT_ID,
        CONNECTOR_ACCOUNT_ID,
        "primary",
      ]),
    );
  });

  it("does not offer account setup from a failed initial inventory and recovers on retry", async () => {
    const localAdapter = adapter();
    vi.mocked(localAdapter.load)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(snapshot());
    render(<LifeOpsConnectionsView adapter={localAdapter} />);

    await screen.findByRole("alert");
    expect(screen.queryByText("No Google account is connected.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue to Google" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Seed selected context" }),
    ).toBeNull();
    expect(localAdapter.connectGoogle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("owner@example.test");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect another Google account" }),
    ).toBeTruthy();
  });

  it("supports an Apple-only bounded seed without fabricating a Google grant", async () => {
    const localAdapter = adapter();
    const apple = calendar("apple_calendar");
    const appleOnly = snapshot();
    vi.mocked(localAdapter.load).mockResolvedValue({
      ...appleOnly,
      googleAccounts: [],
      calendars: [apple],
      calendarFeed: {
        ...appleOnly.calendarFeed,
        state: "complete",
        sources: [source(apple)],
      },
      gmailHealthByGrantId: {},
      applePermission: {
        ...appleOnly.applePermission,
        status: "granted",
        canRequest: false,
      },
    });
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("No Google account is connected.");

    const seedButton = screen.getByRole("button", {
      name: "Seed selected context",
    });
    expect((seedButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(seedButton);

    await waitFor(() => expect(localAdapter.seed).toHaveBeenCalledOnce());
    expect(localAdapter.seed).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: null,
        includeGmail: false,
        calendarKeys: [expect.stringContaining("apple-personal")],
      }),
      expect.any(Function),
    );
    expect((await screen.findByTestId("seed-receipt")).textContent).toContain(
      "from 1 source",
    );
  });

  it("focuses destructive confirmation and lets Escape cancel it", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    fireEvent.click(
      screen.getByRole("button", { name: /Purge imported Google data/ }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Remove imported Google data for owner@example.test?",
      }),
    ).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirm purge" }),
    );
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(localAdapter.purgeImportedData).not.toHaveBeenCalled();
  });

  it("surfaces System Settings launch failures as recoverable UI errors", async () => {
    const localAdapter = adapter();
    vi.mocked(localAdapter.openApplePermissionSettings).mockRejectedValue(
      new Error("System Settings is unavailable."),
    );
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    fireEvent.click(
      screen.getByRole("button", { name: "Open System Settings" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "System Settings is unavailable.",
    );
  });
});

describe("account replacement", () => {
  function replacementSnapshot() {
    const state = snapshot();
    const account = googleStatus();
    if (!account.grant) throw new Error("fixture requires a grant");
    account.grant = {
      ...account.grant,
      id: "replacement",
      identityEmail: "real@example.test",
      connectorAccountId: "real-account",
    };
    const replacementCalendar = {
      ...calendar("google"),
      grantId: "replacement",
      connectorAccountId: "real-account",
    };
    state.googleAccounts.push(account);
    state.calendars.push(replacementCalendar);
    state.calendarFeed.sources.push(source(replacementCalendar));
    state.gmailHealthByGrantId = {
      ...state.gmailHealthByGrantId,
      replacement: {
        ...state.gmailHealthByGrantId[GRANT_ID],
        grantId: "replacement",
        connectorAccountId: "real-account",
      },
    };
    return state;
  }
  const selection = {
    previousGrantId: GRANT_ID,
    replacementGrantId: "replacement",
  };

  it("rechecks health before removing only the reviewed test account", async () => {
    const state = replacementSnapshot();
    const local = adapter();
    local.load = vi.fn(async () => state);
    local.disconnectGoogle = vi.fn(async (id) => {
      state.googleAccounts = state.googleAccounts.filter(
        (account) => account.grant?.id !== id,
      );
    });
    await retireReplacedAccount(local, selection);
    expect(local.load).toHaveBeenCalledWith({ forceSync: true });
    expect(local.disconnectGoogle).toHaveBeenCalledExactlyOnceWith(GRANT_ID);
    expect(local.setCalendarIncluded).not.toHaveBeenCalled();
    expect(local.purgeImportedData).not.toHaveBeenCalled();
    expect(
      state.googleAccounts.some(
        (account) => account.grant?.id === "replacement",
      ),
    ).toBe(true);
  });

  it.each([
    { identityEmail: " OWNER@example.test " },
    { connectorAccountId: CONNECTOR_ACCOUNT_ID },
  ])(
    "does not disconnect duplicate connections to the same account: %j",
    async (identity) => {
      const state = replacementSnapshot();
      const replacement = state.googleAccounts.find(
        (account) => account.grant?.id === selection.replacementGrantId,
      );
      if (!replacement?.grant) throw new Error("fixture requires replacement");
      replacement.grant = { ...replacement.grant, ...identity };
      const local = adapter();
      local.load = vi.fn(async () => state);
      await expect(retireReplacedAccount(local, selection)).rejects.toThrow(
        "same Google account",
      );
      expect(local.disconnectGoogle).not.toHaveBeenCalled();
      expect(local.purgeImportedData).not.toHaveBeenCalled();
    },
  );

  it("preserves calendar selections when disconnect fails", async () => {
    const state = replacementSnapshot();
    const before = structuredClone(state);
    const local = adapter();
    local.load = vi.fn(async () => state);
    local.disconnectGoogle = vi.fn(async () => {
      throw new Error("Provider disconnect unavailable");
    });
    local.setCalendarIncluded = vi.fn(async (calendar, included) => {
      const saved = state.calendars.find(
        (item) =>
          item.grantId === calendar.grantId &&
          item.calendarId === calendar.calendarId,
      );
      if (!saved) throw new Error("Calendar missing");
      saved.includeInFeed = included;
    });
    await expect(retireReplacedAccount(local, selection)).rejects.toThrow(
      "Provider disconnect unavailable",
    );
    expect(state.calendars).toEqual(before.calendars);
    expect(state.googleAccounts).toEqual(before.googleAccounts);
    expect(local.setCalendarIncluded).not.toHaveBeenCalled();
    expect(local.purgeImportedData).not.toHaveBeenCalled();
  });

  it.each(["lost response", "completed", "unmounted"] as const)(
    "advances reviewed choices with %s without directly disconnecting",
    async (outcome) => {
      const state = replacementSnapshot();
      const local = adapter();
      local.load = vi.fn(async () => state);
      let saved: AccountHandoffRecord | null = null;
      const pendingResponse = Promise.withResolvers<void>();
      const api: AccountHandoffAdapter = {
        getActiveLifeOpsAccountHandoff: vi.fn(async () => ({ handoff: saved })),
        getLifeOpsHandoffCalendarEntries: vi.fn(async () => ({ entries: [] })),
        getLifeOpsHandoffRetirementCandidates: vi.fn(async () => ({
          candidates: [],
        })),
        getLifeOpsFamilyEmailOptions: vi.fn(async () => ({
          options: {
            accounts: [],
            recipients: [
              { entityId: "self", name: "Self", address: "self@example.test" },
            ],
          },
        })),
        createLifeOpsAccountHandoff: vi.fn(async (choices) => {
          saved = {
            operationId: choices.operationId,
            revision: 3,
            phase: "reviewed",
            receipt: {},
            review: {
              previous: {
                grantId: GRANT_ID,
                connectorAccountId: CONNECTOR_ACCOUNT_ID,
                email: "owner@example.test",
              },
              replacement: {
                grantId: "replacement",
                connectorAccountId: "real-account",
                email: "real@example.test",
              },
              readCalendars: [],
              writeCalendar: null,
              calendarLinks: [],
              messageDestinations: choices.messageDestinations,
              importedData: choices.importedData,
              retireApprovalIds: choices.retireApprovalIds,
            },
          };
          return { handoff: saved };
        }),
        getLifeOpsAccountHandoff: vi.fn(async () => {
          if (!saved) throw new Error("No review");
          return { handoff: saved };
        }),
        cancelLifeOpsAccountHandoff: vi.fn(async () => {
          throw new Error("Not exercised");
        }),
        advanceLifeOpsAccountHandoff: vi.fn(async (id, revision) => {
          if (!saved || saved.operationId !== id || saved.revision !== revision)
            throw new Error("Stale review");
          if (outcome === "unmounted") {
            await pendingResponse.promise;
            saved = { ...saved, phase: "pausing", revision: revision + 1 };
            return { handoff: saved };
          }
          if (outcome === "lost response") {
            saved = { ...saved, phase: "pausing", revision: revision + 1 };
            throw new Error("Response lost. Refresh saved progress.");
          }
          const phase =
            saved.phase === "reviewed"
              ? "pausing"
              : saved.phase === "pausing"
                ? "applying_mappings"
                : saved.receipt.mappingDestination
                  ? "completed"
                  : "applying_mappings";
          saved = {
            ...saved,
            phase,
            revision: revision + 1,
            receipt:
              saved.phase === "applying_mappings"
                ? {
                    mappingDestination: {
                      controlRevision: 1,
                      operationKey: id,
                    },
                  }
                : saved.receipt,
          };
          return { handoff: saved };
        }),
      };
      const view = render(
        <LifeOpsConnectionsView adapter={local} handoffAdapter={api} />,
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Replace an account" }),
      );
      fireEvent.change(
        await screen.findByRole("combobox", {
          name: "Test account to disconnect",
        }),
        { target: { value: GRANT_ID } },
      );
      fireEvent.change(
        screen.getByRole("combobox", { name: "Real account to keep" }),
        { target: { value: "replacement" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Load account details" }),
      );
      fireEvent.change(
        await screen.findByRole("combobox", {
          name: "Verified monthly email recipient",
        }),
        { target: { value: "self" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Save choices for review" }),
      );
      const start = await screen.findByRole("button", {
        name: "Start reviewed account switch",
      });
      expect(api.createLifeOpsAccountHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          previousGrantId: GRANT_ID,
          replacementGrantId: "replacement",
          writeCalendarId: null,
          importedData: "retain",
          messageDestinations: [
            {
              channel: "email",
              connectorAccountId: "real-account",
              recipientId: "self@example.test",
              recipientEntityId: "self",
            },
          ],
        }),
      );
      expect(api.advanceLifeOpsAccountHandoff).not.toHaveBeenCalled();
      fireEvent.click(start);
      if (outcome === "unmounted") {
        await waitFor(() =>
          expect(api.advanceLifeOpsAccountHandoff).toHaveBeenCalledTimes(1),
        );
        view.unmount();
        await act(async () => pendingResponse.resolve());
        expect(api.advanceLifeOpsAccountHandoff).toHaveBeenCalledTimes(1);
        expect(local.disconnectGoogle).not.toHaveBeenCalled();
        return;
      }
      if (outcome === "completed") {
        await screen.findByText("Account switch complete");
        expect(api.advanceLifeOpsAccountHandoff).toHaveBeenCalledTimes(4);
        expect(local.disconnectGoogle).not.toHaveBeenCalled();
        expect(local.purgeImportedData).not.toHaveBeenCalled();
        expect(
          screen.queryByRole("button", { name: "Continue account switch" }),
        ).toBeNull();
        return;
      }
      await screen.findByText("Response lost. Refresh saved progress.");
      expect(
        screen
          .getByRole("button", { name: "Start reviewed account switch" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(local.disconnectGoogle).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh saved progress" }),
      );
      await screen.findByText("Pausing scheduled delivery");
      expect(api.advanceLifeOpsAccountHandoff).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole("button", { name: "Cancel review" }),
      ).toBeNull();
      expect(api.getLifeOpsAccountHandoff).toHaveBeenCalled();
    },
  );

  it("does not retire an account when replacement health deteriorates after review", async () => {
    const state = replacementSnapshot();
    reviewAccountTransition(state, selection);
    const replacementSource = state.calendarFeed.sources.find(
      (item) => item.key.grantId === "replacement",
    );
    if (!replacementSource)
      throw new Error("fixture requires replacement source");
    replacementSource.status = "error";
    const local = adapter();
    local.load = vi.fn(async () => state);
    await expect(retireReplacedAccount(local, selection)).rejects.toThrow(
      "not verified",
    );
    expect(local.disconnectGoogle).not.toHaveBeenCalled();
    expect(local.setCalendarIncluded).not.toHaveBeenCalled();
  });

  it("does not claim completion when disconnect readback still shows the account", async () => {
    const local = adapter();
    local.load = vi.fn(async () => replacementSnapshot());
    await expect(retireReplacedAccount(local, selection)).rejects.toThrow(
      "still appears connected",
    );
  });
});
