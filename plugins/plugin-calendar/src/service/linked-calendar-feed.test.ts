/**
 * Exercises feed deduplication using canonical linked-event identities and
 * deterministic provider DTOs. No provider or persistence is replaced inside
 * the merger; live Google/browser evidence covers the transport separately.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { mergeAggregatedCalendarFeedEvents } from "./CalendarService.js";
import type { LinkedCalendarEventRecord } from "./linked-calendar-sync.js";

const local: LifeOpsCalendarEvent = {
  id: "agent:eliza:local-1",
  externalId: "local-1",
  agentId: "agent",
  provider: "eliza",
  side: "owner",
  grantId: "eliza-calendar",
  connectorAccountId: "eliza-calendar",
  calendarId: "primary",
  title: "School pickup",
  description: "Meet at the front gate",
  location: "School",
  status: "confirmed",
  startAt: "2026-09-15T14:00:00.000Z",
  endAt: "2026-09-15T14:30:00.000Z",
  isAllDay: false,
  timezone: "America/New_York",
  htmlLink: null,
  conferenceLink: null,
  organizer: { self: true },
  attendees: [],
  metadata: { version: 2, etag: '"eliza-2"' },
  recurrence: null,
  recurringEventId: null,
  syncedAt: "2026-09-14T12:00:00.000Z",
  updatedAt: "2026-09-14T12:00:00.000Z",
};
const google: LifeOpsCalendarEvent = {
  ...local,
  id: "agent:google:remote-1",
  externalId: "remote-1",
  provider: "google",
  grantId: "connector-account:test-account",
  connectorAccountId: "test-account",
  calendarId: "test-calendar",
  metadata: { etag: '"google-2"', iCalUID: "remote-1@google.com" },
  updatedAt: "2026-09-14T12:01:00.000Z",
};
const link: LinkedCalendarEventRecord = {
  id: "mapping-1",
  agentId: "agent",
  localEventId: local.id,
  connectorAccountId: "test-account",
  providerCalendarId: "test-calendar",
  providerEventId: "remote-1",
  providerEtag: '"google-2"',
  localRevision: 2,
  state: "clean",
  pendingOperation: null,
  lastCommonSemanticHash: "verified-common-version",
  idempotencyKey: "linked-calendar:agent:local-1",
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: local.updatedAt,
  updatedAt: google.updatedAt,
};
function sources(
  events: LifeOpsCalendarEvent[],
): Parameters<typeof mergeAggregatedCalendarFeedEvents>[0] {
  return events.map((event) => {
    if (!event.grantId || !event.connectorAccountId)
      throw new Error("Fixture source identity is required");
    return {
      calendar: {
        provider: event.provider,
        side: event.side,
        grantId: event.grantId,
        connectorAccountId: event.connectorAccountId,
        calendarId: event.calendarId,
        accountEmail: null,
        summary: event.calendarId,
        accessRole: "owner",
      },
      feed: {
        calendarId: event.calendarId,
        events: [event],
        source: "synced",
        state: "complete",
        sources: [],
        timeMin: local.startAt,
        timeMax: local.endAt,
        syncedAt: event.syncedAt,
      },
    };
  });
}

describe("canonical linked calendar feed", () => {
  it("keeps one appointment during a linked update without losing either snapshot", () => {
    const edited = {
      ...local,
      title: "Pickup moved",
      startAt: "2026-09-15T15:00:00.000Z",
      endAt: "2026-09-15T15:30:00.000Z",
      metadata: { version: 3, etag: '"eliza-3"' },
    };
    const pending: LinkedCalendarEventRecord = {
      ...link,
      localRevision: 3,
      state: "dirty",
      pendingOperation: "update",
    };
    const merged = mergeAggregatedCalendarFeedEvents(
      sources([google, edited]),
      [pending],
    );
    expect(
      merged.map((event) => [event.id, event.title, event.startAt]),
    ).toEqual([[edited.id, edited.title, edited.startAt]]);
    expect(merged[0].metadata.deduplication).toMatchObject({
      conflictingFields: expect.arrayContaining(["title", "startAt", "endAt"]),
      pendingUpdate: {
        linkId: link.id,
        snapshots: expect.arrayContaining([
          expect.objectContaining(edited),
          expect.objectContaining(google),
        ]),
      },
    });
    for (const patch of [
      { agentId: "other" },
      { connectorAccountId: "other" },
      { providerCalendarId: "other" },
      { providerEventId: "other" },
      { providerEtag: '"unreviewed-provider-change"' },
      { localRevision: 4 },
      { state: "quarantined" as const },
      { state: "conflicted" as const },
    ]) {
      expect(
        mergeAggregatedCalendarFeedEvents(sources([google, edited]), [
          { ...pending, ...patch },
        ]),
      ).toHaveLength(2);
    }
  });

  it("renders one editable local event while retaining its Google provenance", () => {
    const merged = mergeAggregatedCalendarFeedEvents(sources([google, local]), [
      link,
    ]);
    expect(merged.map((event) => [event.id, event.title])).toEqual([
      [local.id, local.title],
    ]);
    expect(merged[0].metadata.deduplication).toMatchObject({
      authoritativeSource: { eventId: local.id, provider: "eliza" },
      sources: expect.arrayContaining([
        expect.objectContaining({ eventId: local.id }),
        expect.objectContaining({ eventId: google.id }),
      ]),
      conflictingFields: [],
    });
  });

  it("does not infer a link from matching titles or times", () => {
    expect(
      mergeAggregatedCalendarFeedEvents(sources([local, google]))
        .map((event) => event.id)
        .sort(),
    ).toEqual([local.id, google.id].sort());
  });

  it.each([
    { agentId: "another-agent" },
    { connectorAccountId: "another-account" },
    { providerCalendarId: "another-calendar" },
    { providerEventId: "another-event" },
    { localRevision: 3 },
    { providerEtag: '"google-3"' },
    { state: "conflicted" as const },
    { pendingOperation: "update" as const },
  ])(
    "keeps both snapshots when mapping scope or version differs: %j",
    (patch) => {
      const merged = mergeAggregatedCalendarFeedEvents(
        sources([local, google]),
        [{ ...link, ...patch }],
      );
      expect(merged.map((event) => event.id).sort()).toEqual(
        [local.id, google.id].sort(),
      );
    },
  );

  it("keeps the provider event when the local source is excluded", () => {
    expect(
      mergeAggregatedCalendarFeedEvents(sources([google]), [link]),
    ).toEqual([expect.objectContaining({ id: google.id, provider: "google" })]);
  });

  it("still collapses the same Google occurrence surfaced through Apple", () => {
    const apple: LifeOpsCalendarEvent = {
      ...google,
      id: "apple-copy",
      provider: "apple_calendar",
      grantId: "apple-calendar",
      connectorAccountId: "apple-calendar",
    };
    const merged = mergeAggregatedCalendarFeedEvents(
      sources([apple, local, google]),
      [link],
    );
    expect(merged.map((event) => event.id)).toEqual([local.id]);
    expect(merged[0].metadata.deduplication).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ eventId: apple.id }),
      ]),
    });
  });
});
