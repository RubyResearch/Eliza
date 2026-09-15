/** Deterministic owner account and read-only provider fixtures shared by handoff verification tests. */
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { verifyAccountHandoffGoogle } from "../../src/lifeops/account-handoff-google-verification.js";
import type { AccountHandoffReview } from "../../src/lifeops/account-handoff-store.js";
export function googleHandoffFixture() {
  const grant: LifeOpsConnectorGrant = {
    id: "replacement-grant",
    agentId: "agent",
    provider: "google",
    connectorAccountId: "replacement",
    side: "owner",
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: [],
    capabilities: [
      "google.calendar.read",
      "google.calendar.write",
      "google.gmail.triage",
      "google.gmail.send",
    ],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  const status: LifeOpsGoogleConnectorStatus = {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: true,
    connected: true,
    reason: "connected",
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: grant.identity,
    grantedCapabilities: [
      "google.calendar.read",
      "google.calendar.write",
      "google.gmail.triage",
      "google.gmail.send",
    ],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: true,
    grant,
  };
  const calendar = {
    grantId: grant.id,
    connectorAccountId: "replacement",
    calendarId: "reviewed-calendar",
  };
  const review: AccountHandoffReview = {
    previous: {
      grantId: "old-grant",
      connectorAccountId: "old",
      email: "old@example.test",
    },
    replacement: {
      grantId: grant.id,
      connectorAccountId: "replacement",
      email: "owner@example.test",
    },
    readCalendars: [calendar],
    writeCalendar: calendar,
    calendarLinks: [],
    messageDestinations: [
      {
        channel: "email",
        connectorAccountId: "replacement",
        recipientId: "self@example.test",
      },
    ],
    importedData: "retain",
    retireApprovalIds: [],
  };
  const calls: string[] = [];
  const entry = {
    calendarId: calendar.calendarId,
    summary: "Test",
    description: null,
    primary: false,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/New_York",
    selected: true,
    deleted: false,
  };
  let history = "12345";
  const accounts = {
    getGoogleConnectorStatus: async (
      _url: URL,
      _mode?: string,
      _side?: string,
      grantId?: string,
    ) => {
      calls.push(`status:${grantId}`);
      return status;
    },
  };
  const google = {
    listCalendars: async ({ accountId }: { accountId: string }) => {
      calls.push(`calendars:${accountId}`);
      return [entry];
    },
    getGmailHistoryId: async ({ accountId }: { accountId: string }) => {
      calls.push(`gmail:${accountId}`);
      return history;
    },
  };
  return {
    grant,
    status,
    entry,
    review,
    calls,
    accounts,
    google,
    setHistory: (value: string) => {
      history = value;
    },
    run: () =>
      verifyAccountHandoffGoogle(
        "agent",
        new URL("http://localhost"),
        review,
        accounts,
        google,
      ),
  };
}
