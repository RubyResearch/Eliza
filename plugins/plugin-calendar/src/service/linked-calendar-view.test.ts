/** Real PGlite reads verify linked-event titles, deleted-event visibility and agent isolation. */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { CalendarService } from "./CalendarService.js";
import { LinkedCalendarRepository } from "./linked-calendar-sync.js";
import { ensureLinkedCalendarEventTable } from "./migration.js";

it("joins current owner event details and retains missing events without exposing another agent", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE SCHEMA app_calendar;
      CREATE TABLE app_calendar.life_calendar_events (
        id TEXT PRIMARY KEY, agent_id TEXT, provider TEXT, side TEXT,
        calendar_id TEXT, external_event_id TEXT, title TEXT, description TEXT,
        location TEXT, status TEXT, start_at TEXT, end_at TEXT, is_all_day BOOLEAN,
        timezone TEXT, html_link TEXT, conference_link TEXT, organizer_json TEXT,
        attendees_json TEXT, metadata_json TEXT, synced_at TEXT, updated_at TEXT,
        connector_account_id TEXT, grant_id TEXT
      )`);
    await ensureLinkedCalendarEventTable(
      async (sql) => (await pg.query<Record<string, unknown>>(sql)).rows,
    );
    const runtime = {
      agentId: "owner-a",
      adapter: { db: drizzle(pg) },
    } as unknown as IAgentRuntime;
    const links = new LinkedCalendarRepository(runtime);
    for (const localEventId of ["event-a", "event-b", "deleted-event"])
      await links.create({
        agentId: "owner-a",
        localEventId,
        connectorAccountId: "google-test",
        providerCalendarId: "test",
        localRevision: 1,
      });
    for (const [id, agent, title] of [
      ["event-a", "owner-a", "Library pickup"],
      ["event-b", "owner-b", "Private other family"],
    ])
      await pg.query(
        `INSERT INTO app_calendar.life_calendar_events
        (id, agent_id, provider, side, calendar_id, external_event_id, title, description,
         location, status, start_at, end_at, is_all_day, attendees_json, metadata_json, synced_at, updated_at)
        VALUES ($1,$2,'eliza','owner','primary',$1,$3,'','','confirmed',
          '2026-09-15T19:00:00Z','2026-09-15T20:00:00Z',false,'[]','{}','2026-09-15T00:00:00Z','2026-09-15T00:00:00Z')`,
        [id, agent, title],
      );
    const service = new CalendarService(runtime);
    const result = await service.listLinkedCalendarEventViews();
    expect(
      result.find((link) => link.localEventId === "event-a")?.event?.title,
    ).toBe("Library pickup");
    expect(
      result.find((link) => link.localEventId === "event-b")?.event,
    ).toBeNull();
    expect(
      result.find((link) => link.localEventId === "deleted-event")?.event,
    ).toBeNull();
    await pg.query(
      "UPDATE app_calendar.life_calendar_events SET title = $1 WHERE id = $2",
      ["Library pickup moved", "event-a"],
    );
    expect(
      (await service.listLinkedCalendarEventViews()).find(
        (link) => link.localEventId === "event-a",
      )?.event?.title,
    ).toBe("Library pickup moved");
    await pg.exec("DROP TABLE app_calendar.life_calendar_events");
    await expect(service.listLinkedCalendarEventViews()).rejects.toThrow();
  } finally {
    await pg.close();
  }
}, 30_000);
