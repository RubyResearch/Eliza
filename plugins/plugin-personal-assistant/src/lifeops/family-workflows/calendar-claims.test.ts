/** Exercises monthly packet projection with explicit link identities, school provenance, and conflicting or incomplete calendar facts. */
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsLinkedCalendarLink,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { collectCalendarClaims } from "./calendar-claims.js";

function event(
  id: string,
  patch: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id,
    externalId: id,
    agentId: "agent",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    grantId: "eliza-calendar",
    title: "School closed",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-10-12T00:00:00.000Z",
    endAt: "2026-10-13T00:00:00.000Z",
    isAllDay: true,
    timezone: "America/New_York",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
    ...patch,
  };
}
function feed(
  events: LifeOpsCalendarEvent[],
  state: LifeOpsCalendarFeed["state"] = "complete",
): LifeOpsCalendarFeed {
  return {
    calendarId: "all",
    events,
    state,
    source: "synced",
    sources: [],
    timeMin: "2026-10-01T00:00:00Z",
    timeMax: "2026-11-01T00:00:00Z",
    syncedAt: "2026-09-10T12:00:00Z",
  };
}
const link: LifeOpsLinkedCalendarLink = {
  id: "link",
  localEventId: "local",
  connectorAccountId: "google-owner",
  providerCalendarId: "school-copy",
  providerEventId: "remote",
  providerEtag: "v1",
  localRevision: 1,
  state: "clean",
  pendingOperation: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "2026-09-10T12:00:00Z",
  updatedAt: "2026-09-10T12:00:00Z",
};
const remote = () =>
  event("remote", {
    provider: "google",
    connectorAccountId: "google-owner",
    calendarId: "school-copy",
    grantId: "google-grant",
    timezone: null,
  });

describe("calendar facts in monthly family packets", () => {
  it("shares only opted-in imported school facts, preserving private calendar edits", () => {
    const privateEvent = event("school-local", {
      title: "Private custody discussion",
      description: "Private note",
      startAt: "2026-10-15T00:00:00.000Z",
      endAt: "2026-10-16T00:00:00.000Z",
    });
    const source = {
      sourceId: "district",
      grantId: privateEvent.grantId,
      calendarId: privateEvent.calendarId,
      providerEventId: privateEvent.externalId,
      event: {
        eventKey: "closure",
        title: "School closed",
        startDate: "2026-10-12",
        endDateExclusive: "2026-10-13",
      },
    };
    const shared = collectCalendarClaims(
      feed([privateEvent]),
      [],
      [{ ...source, packetVisibility: "guest_shareable" }],
    );
    expect(shared[0]).toMatchObject({
      statement: "School closed",
      dates: ["2026-10-12"],
      visibility: "guest_shareable",
    });
    expect(JSON.stringify(shared)).not.toContain("Private custody discussion");
    expect(JSON.stringify(shared)).not.toContain("Private note");
    const unreviewed = collectCalendarClaims(
      feed([privateEvent]),
      [],
      [source],
    );
    expect(unreviewed[0]).toMatchObject({
      statement: "Private custody discussion",
      dates: ["2026-10-15"],
      visibility: "owner_only",
    });
  });
  it.each([
    { startAt: "2026-02-30T00:00:00Z", endAt: "2026-03-03T00:00:00Z" },
    { startAt: "not-a-date", endAt: "2026-03-03T00:00:00Z" },
    { startAt: "2026-03-03T00:00:00Z", endAt: "2026-03-03T00:00:00Z" },
  ])("rejects invalid all-day bounds before drafting: $startAt", (bounds) => {
    expect(() =>
      collectCalendarClaims(feed([event("invalid", bounds)]), [], []),
    ).toThrow(/invalid all-day date bounds/);
  });
  it("combines explicit copies into one school fact with civil dates and both source references", () => {
    const claims = collectCalendarClaims(
      feed([remote(), event("local")]),
      [link],
      [
        {
          sourceId: "district",
          grantId: "eliza-calendar",
          calendarId: "primary",
          providerEventId: "local",
          event: {
            eventKey: "october-closure",
            title: "School closed",
            startDate: "2026-10-12",
            endDateExclusive: "2026-10-13",
          },
        },
      ],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      section: "school",
      dates: ["2026-10-12"],
      visibility: "owner_only",
    });
    expect(claims[0]?.provenance.map((source) => source.sourceId)).toEqual([
      "remote",
      "local",
      "district:october-closure",
    ]);
  });
  it("keeps unrelated matching titles and provider IDs from a different account", () => {
    const claims = collectCalendarClaims(
      feed([
        event("local"),
        remote(),
        event("unrelated"),
        event("other-account", {
          ...remote(),
          id: "other-account",
          connectorAccountId: "different-owner",
        }),
      ]),
      [link],
      [],
    );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.stableKey)).size).toBe(3);
  });
  it("keeps the same claim identity when the Google copy appears later", () => {
    const before = collectCalendarClaims(feed([event("local")]), [link], []);
    const after = collectCalendarClaims(
      feed([remote(), event("local")]),
      [link],
      [],
    );
    expect(after[0]?.stableKey).toBe(before[0]?.stableKey);
  });
  it("renders a multi-day school break through its inclusive final date", () => {
    const claims = collectCalendarClaims(
      feed([
        event("break", {
          startAt: "2026-12-24T00:00:00.000Z",
          endAt: "2027-01-02T00:00:00.000Z",
        }),
      ]),
      [],
      [],
    );
    expect(claims[0]?.dates).toEqual(["2026-12-24 through 2027-01-01"]);
  });
  it.each(["partial", "unavailable"] as const)(
    "refuses a %s calendar feed even when events are present",
    (state) => {
      expect(() =>
        collectCalendarClaims(feed([event("local")], state), [], []),
      ).toThrow(/Refresh unavailable calendar sources/);
    },
  );
  it("refuses unresolved linked changes instead of dropping one side", () => {
    expect(() =>
      collectCalendarClaims(
        feed([event("local"), remote()]),
        [{ ...link, state: "conflicted" }],
        [],
      ),
    ).toThrow(/Resolve calendar synchronization/);
    expect(() =>
      collectCalendarClaims(
        feed([event("local"), { ...remote(), title: "Different plan" }]),
        [link],
        [],
      ),
    ).toThrow(/Linked calendars disagree/);
  });
});
