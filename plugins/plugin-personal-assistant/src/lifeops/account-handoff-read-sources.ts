/**
 * Checks the replacement account's canonical feed selection against the saved
 * review. Provider readability alone does not prove that the requested calendars
 * enter the app feed. Scoped discovery failures propagate from CalendarService.
 */
import { ElizaError } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import type { AccountHandoffReview } from "./account-handoff-store.js";

export async function verifyAccountHandoffReadSources(
  calendar: Pick<CalendarService, "listCalendars">,
  requestUrl: URL,
  review: AccountHandoffReview,
): Promise<void> {
  const discovered = await calendar.listCalendars(requestUrl, {
    mode: "local",
    side: "owner",
    grantId: review.replacement.grantId,
  });
  const expected = new Set(
    review.readCalendars.map((source) => source.calendarId),
  );
  const sources = discovered.filter(
    (source) =>
      source.provider === "google" &&
      source.side === "owner" &&
      source.grantId === review.replacement.grantId &&
      source.connectorAccountId === review.replacement.connectorAccountId,
  );
  const included = sources.filter((source) => source.includeInFeed);
  if (
    sources.length !== discovered.length ||
    new Set(sources.map((source) => source.calendarId)).size !==
      sources.length ||
    included.length !== expected.size ||
    included.some((source) => !expected.has(source.calendarId))
  ) {
    throw new ElizaError(
      "The replacement calendar sources do not match the saved review. Refresh Calendar Sources and restore the reviewed selection before continuing.",
      { code: "ACCOUNT_HANDOFF_READ_SOURCES_CHANGED" },
    );
  }
}
