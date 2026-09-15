/**
 * Verifies the reviewed Google identity and selected calendar permissions with
 * fresh provider reads. The receipt covers Google only; channel delivery and
 * account-disconnect authorization remain separate handoff requirements.
 */
import { ElizaError } from "@elizaos/core";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import type { LifeOpsGoogleCapability } from "@elizaos/shared";
import type { AccountHandoffReview } from "./account-handoff-store.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

export interface AccountHandoffGoogleVerification {
  connectorAccountId: string;
  grantId: string;
  email: string;
  calendarIds: string[];
  writableCalendarId: string | null;
  gmailHistoryId: string | null;
  checkedAt: string;
}

export async function verifyAccountHandoffGoogle(
  agentId: string,
  requestUrl: URL,
  review: AccountHandoffReview,
  accounts: Pick<LifeOpsGoogleService, "getGoogleConnectorStatus">,
  google: Pick<IGoogleWorkspaceService, "listCalendars" | "getGmailHistoryId">,
): Promise<AccountHandoffGoogleVerification> {
  const unavailable = (message: string) =>
    new ElizaError(message, {
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
  const status = await accounts.getGoogleConnectorStatus(
    requestUrl,
    "local",
    "owner",
    review.replacement.grantId,
  );
  const grant = status.grant;
  if (!status.connected || status.side !== "owner" || !grant)
    throw unavailable(
      "Reconnect the reviewed replacement Google account before continuing.",
    );
  if (
    grant.agentId !== agentId ||
    grant.side !== "owner" ||
    grant.provider !== "google" ||
    grant.id !== review.replacement.grantId ||
    grant.connectorAccountId !== review.replacement.connectorAccountId ||
    grant.identityEmail?.toLowerCase() !==
      review.replacement.email.toLowerCase()
  )
    throw unavailable(
      "The connected Google identity no longer matches the reviewed replacement account.",
    );
  const selected = [
    ...review.readCalendars,
    ...(review.writeCalendar ? [review.writeCalendar] : []),
  ];
  if (
    selected.some(
      (calendar) =>
        calendar.grantId !== grant.id ||
        calendar.connectorAccountId !== grant.connectorAccountId,
    )
  )
    throw unavailable("Review calendars belonging to the replacement account.");
  const emailDestinations = review.messageDestinations.filter(
    (destination) => destination.channel === "email",
  );
  if (
    emailDestinations.some(
      (destination) =>
        destination.connectorAccountId !== grant.connectorAccountId,
    )
  )
    throw unavailable(
      "The reviewed email destination must use the replacement account.",
    );
  if (!selected.length && !emailDestinations.length)
    throw unavailable(
      "Select a Google calendar or email capability before verifying this replacement account.",
    );
  const required = new Map<LifeOpsGoogleCapability, string>();
  if (selected.length) required.set("google.calendar.read", "calendar reading");
  if (review.writeCalendar)
    required.set("google.calendar.write", "calendar editing");
  if (emailDestinations.length) {
    required.set("google.gmail.triage", "Gmail reading");
    required.set("google.gmail.send", "email sending");
  }
  for (const [capability, description] of required)
    if (!grant.capabilities.includes(capability))
      throw unavailable(
        `Reconnect the replacement account and allow ${description}.`,
      );
  const calendarIds = [
    ...new Set(selected.map((calendar) => calendar.calendarId)),
  ];
  if (calendarIds.length) {
    const calendars = await google.listCalendars({
      accountId: grant.connectorAccountId,
    });
    for (const calendarId of calendarIds) {
      const entry = calendars.find(
        (calendar) => calendar.calendarId === calendarId && !calendar.deleted,
      );
      if (!entry || !["reader", "writer", "owner"].includes(entry.accessRole))
        throw unavailable(
          "A reviewed calendar is no longer readable. Refresh the handoff review.",
        );
      if (
        review.writeCalendar?.calendarId === calendarId &&
        !["writer", "owner"].includes(entry.accessRole)
      )
        throw unavailable(
          "The reviewed destination calendar is no longer writable.",
        );
    }
  }
  const gmailHistoryId = emailDestinations.length
    ? await google.getGmailHistoryId({ accountId: grant.connectorAccountId })
    : null;
  if (gmailHistoryId !== null && !gmailHistoryId.trim())
    throw unavailable(
      "Google did not return a valid Gmail authorization probe.",
    );
  return {
    connectorAccountId: grant.connectorAccountId,
    grantId: grant.id,
    email: review.replacement.email,
    calendarIds,
    writableCalendarId: review.writeCalendar?.calendarId ?? null,
    gmailHistoryId,
    checkedAt: new Date().toISOString(),
  };
}
