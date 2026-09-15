/**
 * No-provider browser fixture for the real LifeOps connection-manager view.
 * Session storage models disconnect/reconnect while all provider-facing work
 * stays inside this deterministic adapter.
 */

import "./lifeops-connections-fixture.css";
import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
  PermissionStatus,
} from "@elizaos/shared";
import { createRoot } from "react-dom/client";
import { FamilyDeletionPanel } from "../../src/components/family-operations/FamilyDeletionPanel.js";
import { FamilyOperationsView } from "../../src/components/family-operations/FamilyOperationsView.js";
import { LifeOpsConnectionsView } from "../../src/components/lifeops-connections/LifeOpsConnectionsView.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
} from "../../src/components/lifeops-connections/types.js";
import { createFamilyDeletionFixture } from "./family-deletion-fixture.js";
import { createFamilyIntakeFixture } from "./family-intake-fixture.js";
import { createFamilyPacketFixture } from "./family-packet-fixture.js";

const GRANT_ID = "connector-account:fixture-account";
const ACCOUNT_ID = "fixture-account";
const SECOND_GRANT_ID = "connector-account:fixture-account-2";
const SECOND_ACCOUNT_ID = "fixture-account-2";
const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "default";
const failure = params.get("failure");
let healthRecovered = false;
let permissionOverride: PermissionStatus | null = null;
let initialLoadFailed = false;

function isConnected(): boolean {
  return sessionStorage.getItem("lifeops-fixture-connected") !== "false";
}

function grant(): LifeOpsConnectorGrant {
  return {
    id: GRANT_ID,
    agentId: "fixture-agent",
    provider: "google",
    connectorAccountId: ACCOUNT_ID,
    side: "owner",
    identity: { email: "fixture-owner@example.test" },
    identityEmail: "fixture-owner@example.test",
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
    tokenRef: "protected:fixture-reference",
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

function secondGrant(): LifeOpsConnectorGrant {
  return {
    ...grant(),
    id: SECOND_GRANT_ID,
    connectorAccountId: SECOND_ACCOUNT_ID,
    identity: { email: "fixture-second@example.test" },
    identityEmail: "fixture-second@example.test",
  };
}

function googleStatus(connected: boolean): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    configured: true,
    connected,
    reason: connected ? "connected" : "disconnected",
    preferredByAgent: connected,
    cloudConnectionId: null,
    identity: connected ? { email: "fixture-owner@example.test" } : null,
    grantedCapabilities: connected
      ? ["google.gmail.triage", "google.gmail.compose", "google.calendar.read"]
      : [],
    grantedScopes: connected ? grant().grantedScopes : [],
    expiresAt: connected ? "2026-08-22T10:00:00.000Z" : null,
    hasRefreshToken: connected,
    grant: connected ? grant() : null,
  };
}

function secondGoogleStatus(): LifeOpsGoogleConnectorStatus {
  return {
    ...googleStatus(true),
    identity: { email: "fixture-second@example.test" },
    grant: secondGrant(),
  };
}

function calendar(provider: "google" | "apple_calendar") {
  const google = provider === "google";
  return {
    provider,
    side: "owner",
    grantId: google ? GRANT_ID : "apple-calendar",
    connectorAccountId: google ? ACCOUNT_ID : "apple-calendar",
    accountEmail: google ? "fixture-owner@example.test" : null,
    calendarId: google ? "primary" : "fixture-apple",
    summary: google ? "Work" : "Personal",
    description: null,
    primary: true,
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
    selectionVersion: 1,
  } satisfies LifeOpsCalendarSummary;
}

function secondGoogleCalendar(): LifeOpsCalendarSummary {
  return {
    ...calendar("google"),
    grantId: SECOND_GRANT_ID,
    connectorAccountId: SECOND_ACCOUNT_ID,
    accountEmail: "fixture-second@example.test",
    calendarId: "fixture-second-primary",
    summary: "Second work",
  };
}

function source(item: LifeOpsCalendarSummary): LifeOpsCalendarSourceHealth {
  const degraded = item.provider === "google" && !healthRecovered;
  return {
    key: {
      provider: item.provider,
      side: item.side,
      grantId: item.grantId,
      connectorAccountId: item.connectorAccountId,
      calendarId: item.calendarId,
    },
    summary: item.summary,
    accessRole: item.accessRole,
    visibility: "details",
    status: degraded ? "stale" : "fresh",
    syncedAt: "2026-08-22T08:00:00.000Z",
    error: degraded
      ? {
          code: "FIXTURE_RATE_LIMIT",
          message: "Fixture quota retry is pending.",
          retryable: true,
        }
      : null,
    changeDelivery:
      item.provider === "google"
        ? {
            mode: "polling",
            status: degraded ? "degraded" : "active",
            expiresAt: null,
            lastNotificationAt: null,
            lastSuccessfulSyncAt: "2026-08-22T08:00:00.000Z",
            error: null,
          }
        : undefined,
  };
}

function snapshot(): LifeOpsConnectionsSnapshot {
  const connected = isConnected();
  const appleOnly = scenario === "apple-only";
  const builtInOnly = scenario === "built-in-only";
  const multiAccount = scenario === "multi-account";
  const calendars = [
    calendar("google"),
    ...(multiAccount ? [secondGoogleCalendar()] : []),
    calendar("apple_calendar"),
  ];
  const visibleCalendars: LifeOpsCalendarSummary[] = builtInOnly
    ? [
        {
          ...calendar("google"),
          provider: "eliza",
          grantId: "eliza-calendar",
          connectorAccountId: "eliza-calendar",
          accountEmail: null,
          calendarId: "eliza-calendar",
          summary: "Eliza Calendar",
          accessRole: "owner",
        },
      ]
    : connected && !appleOnly
      ? calendars
      : calendars.filter((item) => item.provider === "apple_calendar");
  const requestedPermission = params.get(
    "permission",
  ) as PermissionStatus | null;
  const permissionStatus =
    permissionOverride ?? requestedPermission ?? "denied";
  return {
    googleAccounts:
      appleOnly || builtInOnly
        ? []
        : [
            googleStatus(connected),
            ...(multiAccount && connected ? [secondGoogleStatus()] : []),
          ],
    calendars: visibleCalendars,
    calendarFeed: {
      calendarId: "all",
      events: [],
      source: "cache",
      state: builtInOnly || healthRecovered ? "complete" : "partial",
      sources: visibleCalendars.map(source),
      timeMin: "2026-07-23T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      syncedAt: "2026-08-22T08:00:00.000Z",
    },
    gmailHealthByGrantId:
      connected && !appleOnly && !builtInOnly
        ? {
            [GRANT_ID]: {
              provider: "google",
              side: "owner",
              grantId: GRANT_ID,
              connectorAccountId: ACCOUNT_ID,
              mailbox: "me",
              state: "current",
              cursorStatus: "incremental",
              historyCursorPresent: true,
              fullResyncReason: null,
              cachedMessageCount: 6,
              syncedAt: "2026-08-22T08:00:00.000Z",
            },
            ...(multiAccount
              ? {
                  [SECOND_GRANT_ID]: {
                    provider: "google" as const,
                    side: "owner" as const,
                    grantId: SECOND_GRANT_ID,
                    connectorAccountId: SECOND_ACCOUNT_ID,
                    mailbox: "me",
                    state: "current" as const,
                    cursorStatus: "incremental" as const,
                    historyCursorPresent: true,
                    fullResyncReason: null,
                    cachedMessageCount: 4,
                    syncedAt: "2026-08-22T08:00:00.000Z",
                  },
                }
              : {}),
          }
        : {},
    applePermission: {
      id: "calendar",
      status: permissionStatus,
      lastChecked: Date.parse("2026-08-22T08:00:00.000Z"),
      canRequest: permissionStatus === "not-determined",
      platform: "darwin",
      reason:
        permissionStatus === "denied"
          ? "Fixture denial: recover in System Settings."
          : undefined,
    },
    observedAt: new Date().toISOString(),
  };
}

let syncControl: import("@elizaos/shared").LifeOpsLinkedCalendarControl = {
  revision: 0,
  paused: true,
  destination: params.has("pending-sync")
    ? { connectorAccountId: ACCOUNT_ID, providerCalendarId: "primary" }
    : null,
  pendingDispatch: params.has("pending-sync")
    ? { linkId: "fixture-pending" }
    : null,
};
const adapter: LifeOpsConnectionsAdapter = {
  async getLinkedCalendarControl() {
    return syncControl;
  },
  async updateLinkedCalendarControl(request) {
    if (request.expectedRevision !== syncControl.revision)
      throw new Error("Calendar sync changed; refresh the review.");
    if (request.operation === "select") {
      if (!syncControl.paused)
        throw new Error(
          "Pause synchronization before selecting a destination.",
        );
      syncControl = {
        ...syncControl,
        destination: request.destination,
        revision: syncControl.revision + 1,
      };
    } else if (request.operation === "recover") {
      if (failure === "recover")
        throw new Error(
          "Provider outcome is still uncertain. Sync remains paused.",
        );
      if (!syncControl.paused || !syncControl.pendingDispatch)
        throw new Error("Pause and load a pending operation before recovery.");
      syncControl = {
        ...syncControl,
        pendingDispatch: null,
        revision: syncControl.revision + 1,
      };
    } else {
      if (request.operation === "resume" && !syncControl.destination)
        throw new Error("Select a destination before resuming.");
      syncControl = {
        ...syncControl,
        paused: request.operation === "pause",
        revision: syncControl.revision + 1,
      };
    }
    return syncControl;
  },
  async load({ forceSync = false } = {}) {
    if (failure === "load" && !initialLoadFailed) {
      initialLoadFailed = true;
      throw new Error("Fixture connection inventory failed.");
    }
    if (forceSync) healthRecovered = true;
    return snapshot();
  },
  async connectGoogle(capabilities) {
    document.documentElement.dataset.connectCapabilities =
      JSON.stringify(capabilities);
    if (failure === "connect") {
      throw new Error("Fixture Google connect failed.");
    }
    if (scenario === "capture-connect") return;
    sessionStorage.setItem("lifeops-fixture-connected", "true");
    window.location.reload();
  },
  async disconnectGoogle() {
    if (failure === "disconnect") {
      throw new Error("Fixture disconnect failed; connection is unchanged.");
    }
    sessionStorage.setItem("lifeops-fixture-connected", "false");
  },
  async setCalendarIncluded(item, includeInFeed) {
    if (failure === "calendar") {
      throw new Error("Fixture calendar selection could not be saved.");
    }
    return {
      ...item,
      includeInFeed,
      selectionVersion: item.selectionVersion + 1,
    };
  },
  async seed(request, onProgress) {
    document.documentElement.dataset.seedRequest = JSON.stringify(request);
    for (const phase of [
      "preparing",
      "gmail",
      "calendar",
      "deduplicating",
      "complete",
    ] as const) {
      onProgress(phase);
      await new Promise((resolve) => window.setTimeout(resolve, 12));
      if (failure === "seed" && phase === "calendar") {
        throw new Error("Fixture initial sync failed during calendar import.");
      }
    }
    return {
      grantId: request.grantId,
      rangeDays: request.rangeDays,
      gmailMessageCount: request.includeGmail ? 6 : 0,
      calendarEventCount: scenario === "apple-only" ? 3 : 5,
      calendarSourceCount: request.calendarKeys.length,
      duplicateEventCount: request.calendarKeys.length > 1 ? 1 : 0,
      completedAt: new Date().toISOString(),
    };
  },
  async purgeImportedData({ grantId, includeGmail, calendars }) {
    if (failure === "purge") {
      throw new Error("Fixture local purge failed; no data was removed.");
    }
    return {
      gmail: includeGmail
        ? {
            provider: "google",
            side: "owner",
            grantId,
            connectorAccountId: ACCOUNT_ID,
            deletedMessageCount: 6,
            deletedSpamReviewCount: 1,
            deletedSyncCursor: true,
            providerMutation: false,
            purgedAt: new Date().toISOString(),
          }
        : null,
      calendars: calendars.map((item) => ({
        provider: item.provider as "google" | "apple_calendar",
        side: item.side,
        grantId: item.grantId,
        connectorAccountId: item.connectorAccountId,
        deletedEventCount: 3,
        deletedSyncStateCount: 1,
        providerMutation: false,
        purgedAt: new Date().toISOString(),
      })),
    };
  },
  async requestApplePermission() {
    if (failure === "permission") {
      throw new Error("Fixture Calendar permission request failed.");
    }
    permissionOverride = "granted";
    return snapshot().applePermission;
  },
  async openApplePermissionSettings() {
    if (failure === "settings") {
      throw new Error("Fixture System Settings launch failed.");
    }
    document.documentElement.dataset.permissionSettingsOpened = "true";
  },
  navigate(path) {
    document.documentElement.dataset.lastNavigation = path;
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("LifeOps fixture requires #root.");
createRoot(root).render(
  scenario === "family-deletion" ? (
    <main style={{ padding: 20, maxWidth: 900, margin: "auto" }}>
      <FamilyDeletionPanel
        adapter={createFamilyDeletionFixture()}
        onChange={async () => undefined}
      />
    </main>
  ) : scenario === "family-packet" ? (
    <FamilyOperationsView
      intakeAdapter={createFamilyIntakeFixture()}
      adapter={createFamilyPacketFixture(
        failure === "revision",
        failure === "decision",
      )}
    />
  ) : (
    <LifeOpsConnectionsView adapter={adapter} />
  ),
);
