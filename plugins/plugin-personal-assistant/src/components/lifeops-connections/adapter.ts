/** Production adapter for LifeOps connection management over canonical local APIs. */

import type { CalendarClientMethods } from "@elizaos/plugin-calendar/api/client-calendar";
import type {
  LifeOpsCalendarProvider,
  LifeOpsCalendarSummary,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  SeedLifeOpsCalendarRequest,
} from "@elizaos/shared";
import { client } from "@elizaos/ui/api";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";
import type { LifeOpsElizaClientMethods } from "../../api/client-lifeops.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
  LifeOpsSeedReceipt,
} from "./types.js";

// Renderer boot imports this plugin's register entry before the page can be
// selected. That entry installs the LifeOps and Calendar client extensions;
// keeping this remote view type-only avoids bundling a host-private API path.
const lifeOpsClient = client as typeof client &
  LifeOpsElizaClientMethods &
  CalendarClientMethods;

function connectedGoogleAccounts(
  accounts: readonly LifeOpsGoogleConnectorStatus[],
): LifeOpsGoogleConnectorStatus[] {
  return accounts.filter(
    (account) => account.connected && account.grant !== null,
  );
}

function calendarIdentity(calendar: LifeOpsCalendarSummary): string {
  return JSON.stringify([
    calendar.provider,
    calendar.side,
    calendar.grantId,
    calendar.connectorAccountId,
    calendar.calendarId,
  ]);
}

/** Inverse of {@link calendarIdentity}; rejects keys that do not name one exact source. */
function parseCalendarKey(
  key: string,
): SeedLifeOpsCalendarRequest["calendars"][number] {
  const parsed: unknown = JSON.parse(key);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    parsed.some((part) => typeof part !== "string")
  ) {
    throw new Error("Calendar selection key does not name one exact source.");
  }
  const [provider, side, grantId, connectorAccountId, calendarId] = parsed as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    provider: provider as LifeOpsCalendarProvider,
    side: side as LifeOpsConnectorSide,
    grantId,
    connectorAccountId,
    calendarId,
  };
}

async function loadSnapshot(
  forceSync = false,
): Promise<LifeOpsConnectionsSnapshot> {
  const [{ accounts }, calendarsResponse, applePermission] = await Promise.all([
    lifeOpsClient.getLifeOpsGoogleConnectorAccounts({ side: "owner" }),
    lifeOpsClient.getLifeOpsCalendars({ side: "owner" }),
    lifeOpsClient.getPermission("calendar"),
  ]);
  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  const calendarFeed = await lifeOpsClient.getLifeOpsCalendarFeed({
    side: "owner",
    timeMin,
    timeMax,
    forceSync,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const gmailHealthEntries = await Promise.all(
    connectedGoogleAccounts(accounts)
      .filter((account) =>
        account.grantedCapabilities.includes("google.gmail.triage"),
      )
      .map(async (account) => {
        const grantId = account.grant?.id;
        if (!grantId) {
          throw new Error("Connected Google account is missing its grant id.");
        }
        return [
          grantId,
          await lifeOpsClient.getLifeOpsGmailSyncHealth({
            grantId,
            side: "owner",
            mode: "local",
          }),
        ] as const;
      }),
  );
  return {
    googleAccounts: accounts,
    calendars: calendarsResponse.calendars,
    calendarFeed,
    gmailHealthByGrantId: Object.fromEntries(gmailHealthEntries),
    applePermission,
    observedAt: new Date().toISOString(),
  };
}

export const defaultLifeOpsConnectionsAdapter: LifeOpsConnectionsAdapter = {
  getLinkedCalendarControl: () => lifeOpsClient.getLinkedCalendarControl(),
  updateLinkedCalendarControl: (request) =>
    lifeOpsClient.updateLinkedCalendarControl(request),
  load: ({ forceSync = false } = {}) => loadSnapshot(forceSync),
  async connectGoogle(capabilities: LifeOpsGoogleCapability[]) {
    const result = await lifeOpsClient.startLifeOpsGoogleConnector({
      side: "owner",
      mode: "local",
      createNewGrant: true,
      capabilities,
      redirectUrl: window.location.href,
    });
    if (!result.authUrl) {
      throw new Error("Google OAuth did not return an authorization URL.");
    }
    window.location.assign(result.authUrl);
  },
  async disconnectGoogle(grantId: string) {
    await lifeOpsClient.disconnectLifeOpsGoogleConnector({
      side: "owner",
      mode: "local",
      grantId,
    });
  },
  async setCalendarIncluded(calendar, includeInFeed) {
    const response = await lifeOpsClient.setLifeOpsCalendarIncluded({
      provider: calendar.provider,
      side: calendar.side,
      grantId: calendar.grantId,
      connectorAccountId: calendar.connectorAccountId,
      calendarId: calendar.calendarId,
      includeInFeed,
      expectedVersion: calendar.selectionVersion,
    });
    return response.calendar;
  },
  async seed(request, onProgress): Promise<LifeOpsSeedReceipt> {
    onProgress("preparing");
    let gmailMessageCount = 0;
    if (request.includeGmail) {
      if (!request.grantId) {
        throw new Error("Gmail seeding requires a connected Google account.");
      }
      onProgress("gmail");
      // The server walks every provider page for the selected range and only
      // returns a receipt when the whole range was imported.
      const gmail = await lifeOpsClient.seedLifeOpsGmail({
        side: "owner",
        mode: "local",
        grantId: request.grantId,
        rangeDays: request.rangeDays,
      });
      gmailMessageCount = gmail.messageCount;
    }
    const calendars = request.calendarKeys.map(parseCalendarKey);
    let calendarEventCount = 0;
    let duplicateEventCount = 0;
    if (calendars.length > 0) {
      onProgress("calendar");
      const now = new Date();
      const calendar = await lifeOpsClient.seedLifeOpsCalendar({
        side: "owner",
        timeMin: new Date(
          now.getTime() - request.rangeDays * 86_400_000,
        ).toISOString(),
        timeMax: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        calendars,
      });
      onProgress("deduplicating");
      calendarEventCount = calendar.eventCount;
      duplicateEventCount = calendar.duplicateEventCount;
    }
    onProgress("complete");
    return {
      grantId: request.grantId,
      rangeDays: request.rangeDays,
      gmailMessageCount,
      calendarEventCount,
      calendarSourceCount: calendars.length,
      duplicateEventCount,
      completedAt: new Date().toISOString(),
    };
  },
  async purgeImportedData({
    grantId,
    connectorAccountId,
    includeGmail,
    calendars,
  }) {
    if (includeGmail && !connectorAccountId) {
      throw new Error(
        "This legacy Google connection has no stable account identity. Reconnect it before purging imported Gmail data.",
      );
    }
    const gmail = includeGmail
      ? await lifeOpsClient.purgeLifeOpsGmailImportedData({
          side: "owner",
          grantId,
          connectorAccountId: connectorAccountId as string,
          confirmAction: true,
        })
      : null;
    const calendarReceipts = [];
    for (const calendar of calendars) {
      if (
        calendar.provider !== "google" &&
        calendar.provider !== "apple_calendar"
      ) {
        continue;
      }
      calendarReceipts.push(
        await lifeOpsClient.purgeLifeOpsCalendarImportedData({
          provider: calendar.provider,
          side: calendar.side,
          grantId: calendar.grantId,
          connectorAccountId: calendar.connectorAccountId,
          confirmAction: true,
        }),
      );
    }
    return { gmail, calendars: calendarReceipts };
  },
  requestApplePermission: () => lifeOpsClient.requestPermission("calendar"),
  openApplePermissionSettings: () =>
    lifeOpsClient.openPermissionSettings("calendar"),
  navigate(path) {
    dispatchNavigateViewEvent({
      viewId: path === "/inbox" ? "inbox" : "calendar",
      viewPath: path,
      source: "user",
    });
  },
};

export { calendarIdentity };
