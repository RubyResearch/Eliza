/**
 * Projects calendar facts into monthly packets using explicit sync identities
 * and persisted school-import provenance. Conflicted or incomplete feeds cannot
 * produce an approval-ready packet; matching prose never establishes identity.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsLinkedCalendarLink,
} from "@elizaos/shared";
import type { FamilyPacketClaim } from "../family-coordination/index.js";
import type { SchoolCalendarImportedEvent } from "../school/calendar-workflow.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dates(event: LifeOpsCalendarEvent): string[] {
  if (!event.isAllDay) return [`${event.startAt} through ${event.endAt}`];
  const start = event.startAt.split("T")[0];
  const exclusive = event.endAt.split("T")[0];
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${exclusive}T00:00:00.000Z`);
  if (
    !start ||
    !exclusive ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    new Date(startTime).toISOString().split("T")[0] !== start ||
    new Date(endTime).toISOString().split("T")[0] !== exclusive ||
    endTime <= startTime
  ) {
    throw new ElizaError(
      "The calendar event has invalid all-day date bounds.",
      {
        code: "FAMILY_PACKET_CALENDAR_INVALID_DATE",
        context: { eventId: event.id },
      },
    );
  }
  const end = new Date(`${exclusive}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const inclusive = end.toISOString().split("T")[0];
  return [start === inclusive ? start : `${start} through ${inclusive}`];
}

function semantic(event: LifeOpsCalendarEvent): string {
  return hash({
    title: event.title,
    description: event.description,
    location: event.location,
    dates: dates(event),
    allDay: event.isAllDay,
    timezone: event.isAllDay ? null : event.timezone,
    status: event.status,
    attendees: event.attendees
      .map((attendee) => ({
        email: attendee.email,
        optional: attendee.optional,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  });
}

export function collectCalendarClaims(
  feed: LifeOpsCalendarFeed,
  links: readonly LifeOpsLinkedCalendarLink[],
  imported: readonly SchoolCalendarImportedEvent[],
): FamilyPacketClaim[] {
  if (feed.state !== "complete") {
    throw new ElizaError(
      "Refresh unavailable calendar sources before generating the family packet.",
      {
        code: "FAMILY_PACKET_CALENDAR_INCOMPLETE",
        context: { state: feed.state },
      },
    );
  }
  const groups = new Map<string, LifeOpsCalendarEvent[]>();
  for (const event of feed.events) {
    const link = links.find(
      (candidate) =>
        candidate.localEventId === event.id ||
        (event.provider === "google" &&
          candidate.connectorAccountId === event.connectorAccountId &&
          candidate.providerCalendarId === event.calendarId &&
          candidate.providerEventId === event.externalId),
    );
    if (link && (link.state !== "clean" || link.pendingOperation !== null)) {
      throw new ElizaError(
        "Resolve calendar synchronization before generating the family packet.",
        {
          code: "FAMILY_PACKET_CALENDAR_UNSETTLED",
          context: { linkId: link.id, state: link.state },
        },
      );
    }
    const key = link ? `calendar:${link.localEventId}` : `calendar:${event.id}`;
    const group = groups.get(key) ?? [];
    if (group.some((existing) => semantic(existing) !== semantic(event))) {
      throw new ElizaError(
        "Linked calendars disagree. Refresh or resolve their events before generating the family packet.",
        {
          code: "FAMILY_PACKET_CALENDAR_DIVERGED",
          context: { key },
        },
      );
    }
    group.push(event);
    groups.set(key, group);
  }
  return [...groups].map(([key, events]) => {
    const event =
      events.find((entry) => entry.provider === "eliza") ?? events[0];
    if (!event)
      throw new ElizaError("Calendar projection lost its event.", {
        code: "FAMILY_PACKET_CALENDAR_INVARIANT",
      });
    const school = imported.find((source) =>
      events.some(
        (entry) =>
          entry.externalId === source.providerEventId &&
          entry.grantId === source.grantId &&
          entry.calendarId === source.calendarId,
      ),
    );
    const shareSchool = school?.packetVisibility === "guest_shareable";
    return {
      claimId: key,
      stableKey: key,
      section: school ? "school" : "custody_calendar",
      statement: shareSchool ? school.event.title : event.title,
      visibility: shareSchool ? "guest_shareable" : "owner_only",
      provenance: [
        ...events.map((entry) => ({
          source: "calendar" as const,
          sourceId: entry.id,
          observedAt: entry.updatedAt,
          contentSha256: hash(entry),
        })),
        ...(school
          ? [
              {
                source: "school" as const,
                sourceId: `${school.sourceId}:${school.event.eventKey}`,
                observedAt: event.updatedAt,
                contentSha256: hash(school.event),
              },
            ]
          : []),
      ],
      dates: dates(
        shareSchool
          ? {
              ...event,
              isAllDay: true,
              startAt: `${school.event.startDate}T00:00:00.000Z`,
              endAt: `${school.event.endDateExclusive}T00:00:00.000Z`,
            }
          : event,
      ),
      requests: [],
      urgency: null,
      commitments: [],
      accountability: [],
    };
  });
}
