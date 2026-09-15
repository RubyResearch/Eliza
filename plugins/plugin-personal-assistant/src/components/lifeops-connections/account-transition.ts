/** Verifies a replacement Google connection before retiring an explicitly selected account. */
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
} from "./types.js";

export interface AccountTransitionSelection {
  previousGrantId: string;
  replacementGrantId: string;
}

export function reviewAccountTransition(
  snapshot: LifeOpsConnectionsSnapshot,
  selection: AccountTransitionSelection,
) {
  const { previousGrantId, replacementGrantId } = selection;
  if (
    !previousGrantId ||
    !replacementGrantId ||
    previousGrantId === replacementGrantId
  )
    throw new Error("Choose two different accounts.");
  const previous = snapshot.googleAccounts.find(
    (account) => account.connected && account.grant?.id === previousGrantId,
  );
  const replacement = snapshot.googleAccounts.find(
    (account) => account.connected && account.grant?.id === replacementGrantId,
  );
  if (!previous?.grant || !replacement?.grant)
    throw new Error(
      "Both accounts must still be connected. Refresh and select them again.",
    );
  const previousEmail = previous.grant.identityEmail;
  const replacementEmail = replacement.grant.identityEmail;
  if (!previousEmail || !replacementEmail)
    throw new Error(
      "Verify the email address of both accounts before switching.",
    );
  if (
    previousEmail.trim().toLowerCase() ===
      replacementEmail.trim().toLowerCase() ||
    (previous.grant.connectorAccountId &&
      previous.grant.connectorAccountId ===
        replacement.grant.connectorAccountId)
  )
    throw new Error(
      "Both connections belong to the same Google account. Choose a different replacement account.",
    );
  const missing = previous.grantedCapabilities.filter(
    (capability) => !replacement.grantedCapabilities.includes(capability),
  );
  if (missing.length)
    throw new Error(
      `The replacement needs the permissions used by the previous account: ${missing.join(", ")}.`,
    );
  const calendars = snapshot.calendars.filter(
    (calendar) =>
      calendar.provider === "google" &&
      calendar.grantId === replacementGrantId &&
      calendar.includeInFeed,
  );
  if (replacement.grantedCapabilities.includes("google.calendar.read")) {
    if (!calendars.length)
      throw new Error(
        "Choose at least one replacement calendar before switching.",
      );
    for (const calendar of calendars) {
      const source = snapshot.calendarFeed.sources.find(
        (candidate) =>
          candidate.key.grantId === replacementGrantId &&
          candidate.key.connectorAccountId === calendar.connectorAccountId &&
          candidate.key.calendarId === calendar.calendarId,
      );
      if (source?.status !== "fresh" || source.error || !source.syncedAt)
        throw new Error(
          `Refresh the replacement calendar ${calendar.summary}; its connection is not verified yet.`,
        );
    }
  }
  if (
    replacement.grantedCapabilities.includes("google.gmail.triage") &&
    snapshot.gmailHealthByGrantId[replacementGrantId]?.state !== "current"
  )
    throw new Error("Refresh the replacement inbox before switching.");
  return {
    previousEmail,
    replacementEmail,
    calendars: calendars.map((calendar) => calendar.summary),
  };
}

export async function retireReplacedAccount(
  adapter: LifeOpsConnectionsAdapter,
  selection: AccountTransitionSelection,
): Promise<void> {
  const current = await adapter.load({ forceSync: true });
  reviewAccountTransition(current, selection);
  // Calendar discovery excludes revoked accounts, so retiring an account does
  // not need to alter saved calendar selections.
  await adapter.disconnectGoogle(selection.previousGrantId);
  const verified = await adapter.load();
  if (
    verified.googleAccounts.some(
      (account) =>
        account.connected && account.grant?.id === selection.previousGrantId,
    )
  )
    throw new Error(
      "The previous account still appears connected. Refresh its status before continuing.",
    );
  if (
    !verified.googleAccounts.some(
      (account) =>
        account.connected && account.grant?.id === selection.replacementGrantId,
    )
  )
    throw new Error(
      "The previous account was disconnected, but the replacement is unavailable. Reconnect it before continuing.",
    );
}
