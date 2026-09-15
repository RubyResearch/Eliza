/**
 * Real-PGlite coverage for the school-calendar source, lease, hash, semantic
 * diff, approval, ownership, and crash-recovery contracts. Network responses
 * use the real DNS-pinned fetch boundary with deterministic Concord-shaped
 * landing/PDF fixtures.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE } from "@elizaos/plugin-calendar";
import type { CalendarOwnerMutationGateway } from "@elizaos/plugin-calendar/routes/mutation-gateway";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectCalendarClaims } from "../family-workflows/calendar-claims.js";
import { FamilyWorkflowRuntimeService } from "../family-workflows/runtime.js";
import {
  ensureFamilyWorkspaceOperationStore,
  fenceFamilyWorkspace,
} from "../family-workflows/workspace-operation-store.js";
import { type RawSqlQuery, withRequiredTransaction } from "../sql.js";
import {
  CONCORD_SCHOOL_CALENDAR_SOURCE,
  diffSchoolCalendarEvents,
  discoverSchoolCalendarPdf,
  parseSchoolCalendarText,
  SchoolCalendarWorkflow,
  type SchoolCalendarWorkflowDeps,
  SchoolCalendarWorkflowError,
} from "./calendar-workflow.js";

const landing = `<!doctype html><a href="https://resources.finalsite.net/images/v1767898007/concordpsorg/fngaaxlgullcz1ezh11m/CPSCCRSD2026-2027SchoolCalendar.pdf">Calendar</a>`;
const twoColumnText = [
  "2026-09-01 | First day of school",
  "Professional development | 2026-10-09",
].join("\n");

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseBody(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function event(externalId: string, title: string): LifeOpsCalendarEvent {
  return {
    id: `agent:eliza:${externalId}`,
    externalId,
    agentId: "agent-a",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-09-02T00:00:00.000Z",
    isAllDay: true,
    timezone: "America/New_York",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: { etag: '"eliza-1"', version: 1 },
    syncedAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    grantId: "eliza-calendar",
    connectorAccountId: "eliza-calendar",
  };
}

describe("school calendar pure contracts", () => {
  it("parses both columns into stable date-owned keys", () => {
    expect(parseSchoolCalendarText(twoColumnText)).toMatchObject([
      {
        eventKey: "school-date:2026-09-01",
        title: "First day of school",
        startDate: "2026-09-01",
        endDateExclusive: "2026-09-02",
      },
      {
        eventKey: "school-date:2026-10-09",
        title: "Professional development",
        startDate: "2026-10-09",
        endDateExclusive: "2026-10-10",
      },
    ]);
  });

  it("parses the Concord two-column layout with school-year inference, ranges, and citations", async () => {
    const fixture = await readFile(
      new URL("./fixtures/concord-2026-2027-layout.txt", import.meta.url),
      "utf8",
    );
    const parsed = parseSchoolCalendarText(fixture);
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "First Day Students",
          startDate: "2026-08-31",
          endDateExclusive: "2026-09-01",
          citation: expect.objectContaining({ page: 1 }),
        }),
        expect.objectContaining({
          title: "February Recess",
          startDate: "2027-02-15",
          endDateExclusive: "2027-02-20",
          citation: expect.objectContaining({
            sourceText: "15-19 February Recess",
          }),
        }),
        expect.objectContaining({
          title: "Columbus Day / Indigenous Peoples' Day",
          startDate: "2026-10-12",
        }),
      ]),
    );
  });

  it("uses PDF geometry to bind an unlabeled event to its nearest month heading", () => {
    const parsed = parseSchoolCalendarText({
      pageCount: 1,
      items: [
        {
          page: 1,
          text: "PreK-12 2026-2027 SCHOOL CALENDAR",
          x: 100,
          y: 760,
          width: 200,
          height: 10,
        },
        { page: 1, text: "FEBRUARY", x: 330, y: 710, width: 60, height: 10 },
        { page: 1, text: "FEBRUARY", x: 430, y: 710, width: 60, height: 10 },
        {
          page: 1,
          text: "15-19 February Recess",
          x: 450,
          y: 660,
          width: 120,
          height: 9,
        },
      ],
    });
    expect(parsed).toEqual([
      expect.objectContaining({
        startDate: "2027-02-15",
        endDateExclusive: "2027-02-20",
        citation: expect.objectContaining({
          bounds: { x: 450, y: 660, width: 120, height: 9 },
        }),
      }),
    ]);
  });

  it("quarantines duplicate ambiguous meanings while permitting distinct same-day events", () => {
    expect(
      parseSchoolCalendarText(
        "2026-09-01 | First day\nOrientation | 2026-09-01",
      ),
    ).toHaveLength(2);
    expect(() =>
      parseSchoolCalendarText("2026-09-01 | First day\nFirst day | 2026-09-01"),
    ).toThrowError(
      expect.objectContaining({ code: "SCHOOL_CALENDAR_PARSE_AMBIGUOUS" }),
    );
  });

  it("rejects a matching-looking PDF link on an untrusted host", () => {
    expect(() =>
      discoverSchoolCalendarPdf(
        '<a href="https://evil.example/CPSCCRSD2026-2027SchoolCalendar.pdf">x</a>',
        CONCORD_SCHOOL_CALENDAR_SOURCE.landingPageUrl,
        CONCORD_SCHOOL_CALENDAR_SOURCE,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "SCHOOL_CALENDAR_URL_NOT_ALLOWED" }),
    );
  });

  it("discovers Finalsite resource-manager links by their declared PDF filename", () => {
    const currentLandingMarkup = `<a
      data-file-name="CPSCCRSD2026-2027SchoolCalendar.pdf"
      data-resource-uuid="ed54b79f-c59a-4e94-b07d-1fa97013b17b"
      href="/fs/resource-manager/view/ed54b79f-c59a-4e94-b07d-1fa97013b17b"
      target="_blank">2026-2027 School Calendar</a>
      <a data-file-name="CPSCCRSD2025-2026SchoolCalendar.pdf"
        href="/fs/resource-manager/view/previous">2025-2026 School Calendar</a>
      <a data-file-name="CPSCCRSD2024-2025SchoolCalendar.pdf"
        href="/fs/resource-manager/view/archived">2024-2025 School Calendar</a>`;

    expect(
      discoverSchoolCalendarPdf(
        currentLandingMarkup,
        CONCORD_SCHOOL_CALENDAR_SOURCE.landingPageUrl,
        CONCORD_SCHOOL_CALENDAR_SOURCE,
      ),
    ).toBe(
      "https://www.concordps.org/fs/resource-manager/view/ed54b79f-c59a-4e94-b07d-1fa97013b17b",
    );
  });

  it("classifies semantic add, update, cancel, and unchanged", () => {
    const previous = [
      {
        eventKey: "school-date:2026-09-01",
        title: "Old title",
        startDate: "2026-09-01",
        endDateExclusive: "2026-09-02",
        providerEventId: "provider-1",
        providerVersion: '"v1"',
        active: true,
      },
      {
        eventKey: "school-date:2026-09-02",
        title: "Removed",
        startDate: "2026-09-02",
        endDateExclusive: "2026-09-03",
        providerEventId: "provider-2",
        providerVersion: '"v1"',
        active: true,
      },
    ];
    const current = [
      {
        eventKey: "school-date:2026-09-01",
        title: "New title",
        startDate: "2026-09-01",
        endDateExclusive: "2026-09-02",
      },
      {
        eventKey: "school-date:2026-09-03",
        title: "Added",
        startDate: "2026-09-03",
        endDateExclusive: "2026-09-04",
      },
    ];
    expect(
      diffSchoolCalendarEvents(previous, current).map((change) => change.kind),
    ).toEqual(["update", "cancel", "add"]);
  });
});

describe("SchoolCalendarWorkflow with real PGlite", () => {
  let db: PGlite;
  let runtime: IAgentRuntime;
  let pdfBytes: Buffer;
  let text: string;
  let workflow: SchoolCalendarWorkflow;
  let workflowDeps: SchoolCalendarWorkflowDeps;
  let gateway: CalendarOwnerMutationGateway;
  let creates: number;
  let createdRanges: Array<{
    title: string;
    startAt: string | undefined;
    endAt: string | undefined;
    allDay: { startDate: string; endDateExclusive: string } | undefined;
  }>;
  let updatedRanges: Array<{
    eventId: string;
    allDay: { startDate: string; endDateExclusive: string } | undefined;
  }>;
  let clock: Date;

  beforeEach(async () => {
    db = await PGlite.create();
    runtime = {
      agentId: "agent-a",
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
          transaction: async <T>(
            fn: (tx: {
              execute: (query: RawSqlQuery) => Promise<unknown>;
            }) => Promise<T> | T,
          ) =>
            db.transaction(async (transaction) =>
              fn({
                execute: async (query) =>
                  transaction.query(
                    query.queryChunks
                      .map((chunk) => chunk.value ?? "")
                      .join(""),
                  ),
              }),
            ),
        },
      },
    } as unknown as IAgentRuntime;
    pdfBytes = Buffer.from("%PDF-concord-fixture-a");
    text = twoColumnText;
    creates = 0;
    createdRanges = [];
    updatedRanges = [];
    clock = new Date("2026-08-30T12:00:00.000Z");
    const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
    const pinnedFetchImpl = vi.fn(async ({ url }: { url: URL }) => {
      if (url.pathname.endsWith(".pdf")) {
        return new Response(responseBody(pdfBytes), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response(landing, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    workflowDeps = {
      lookupFn,
      pinnedFetchImpl: pinnedFetchImpl as never,
      extractPdfText: async () => text,
      retainPdf: async (bytes: Buffer) => ({
        url: `/api/media/${hash(bytes)}.pdf`,
        hash: hash(bytes),
      }),
      now: () => clock,
    };
    workflow = new SchoolCalendarWorkflow(runtime, workflowDeps);
    gateway = {
      async create(_url, request) {
        creates += 1;
        createdRanges.push({
          title: request.title,
          startAt: request.startAt,
          endAt: request.endAt,
          allDay: request.allDay,
        });
        return {
          outcome: "event",
          event: event(`provider-${creates}`, request.title),
          writeOnlyReceipt: null,
        };
      },
      async update(_url, request) {
        updatedRanges.push({
          eventId: request.eventId,
          allDay: request.allDay,
        });
        return event(request.eventId, request.title ?? "updated");
      },
      async cancel() {
        return { cancelled: true } as never;
      },
    };
  });

  afterEach(async () => {
    await db.close();
  });

  it.each(["configuration", "run", "application"] as const)(
    "rejects school %s after the workspace fence and preserves recorded source data",
    async (kind) => {
      const initial = await workflow.run();
      if (initial.state !== "awaiting_approval")
        throw new Error("Expected a reviewable school run");
      await ensureFamilyWorkspaceOperationStore(runtime);
      await withRequiredTransaction(runtime, (tx) =>
        fenceFamilyWorkspace(tx, runtime.agentId),
      );
      const tables = [
        "life_school_calendar_sources",
        "life_school_calendar_runs",
        "life_school_calendar_events",
        "life_school_calendar_apply_operations",
      ];
      const before = await Promise.all(
        tables.map(
          async (table) =>
            (await db.query(`SELECT * FROM app_lifeops.${table}`)).rows,
        ),
      );
      const mutate = () => {
        switch (kind) {
          case "configuration":
            return workflow.configure({
              ...CONCORD_SCHOOL_CALENDAR_SOURCE,
              schoolLevel: "elementary",
              updateMode: "automatic",
            });
          case "run":
            return workflow.run();
          case "application":
            return workflow.applyApprovedPlan({
              runId: initial.runId,
              gateway,
              requestUrl: new URL("http://localhost"),
            });
        }
      };
      await expect(mutate()).rejects.toMatchObject({
        code: "FAMILY_WORKSPACE_FENCED",
      });
      const after = await Promise.all(
        tables.map(
          async (table) =>
            (await db.query(`SELECT * FROM app_lifeops.${table}`)).rows,
        ),
      );
      expect(after).toEqual(before);
      expect(creates).toBe(0);
      expect(updatedRanges).toEqual([]);
    },
  );

  it("holds deletion through PDF extraction and settles only after the review is persisted", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new SchoolCalendarWorkflow(runtime, {
      ...workflowDeps,
      extractPdfText: async () => {
        entered();
        await pending;
        return text;
      },
    });
    const work = held.run();
    await started;
    try {
      await expect(
        withRequiredTransaction(runtime, (tx) =>
          fenceFamilyWorkspace(tx, runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    } finally {
      release();
    }
    expect((await work).state).toBe("awaiting_approval");
    await withRequiredTransaction(runtime, (tx) =>
      fenceFamilyWorkspace(tx, runtime.agentId),
    );
    await expect(
      new SchoolCalendarWorkflow(runtime, workflowDeps).run(),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
  });

  it("settles an acknowledged fetch failure without leaving a permanent deletion claim", async () => {
    const failed = new SchoolCalendarWorkflow(runtime, {
      ...workflowDeps,
      lookupFn: async () => {
        throw new Error("DNS fixture unavailable");
      },
    });
    await expect(failed.run()).rejects.toThrow();
    const rows = await db.query(
      "SELECT state FROM app_lifeops.life_school_calendar_runs",
    );
    expect(rows.rows).toEqual([{ state: "failed" }]);
    await withRequiredTransaction(runtime, (tx) =>
      fenceFamilyWorkspace(tx, runtime.agentId),
    );
  });

  it("preserves the PDF identity and durable claim when storage acknowledgement is lost", async () => {
    const failed = new SchoolCalendarWorkflow(runtime, {
      ...workflowDeps,
      retainPdf: async () => {
        throw new Error("storage acknowledgement lost");
      },
    });
    await expect(failed.run()).rejects.toThrow("storage acknowledgement lost");
    const rows = await db.query(
      "SELECT state,content_sha256,media_url FROM app_lifeops.life_school_calendar_runs",
    );
    expect(rows.rows).toEqual([
      {
        state: "failed",
        content_sha256: hash(pdfBytes),
        media_url: `/api/media/${hash(pdfBytes)}.pdf`,
      },
    ]);
    await expect(
      withRequiredTransaction(runtime, (tx) =>
        fenceFamilyWorkspace(tx, runtime.agentId),
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
  });

  it("holds deletion through calendar delivery and its final receipt", async () => {
    const result = await workflow.run();
    if (result.state !== "awaiting_approval")
      throw new Error("Expected a reviewable school run");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldGateway: CalendarOwnerMutationGateway = {
      ...gateway,
      create: async (url, request) => {
        entered();
        await pending;
        return gateway.create(url, request);
      },
    };
    const work = workflow.applyApprovedPlan({
      runId: result.runId,
      gateway: heldGateway,
      requestUrl: new URL("http://localhost"),
    });
    await started;
    try {
      await expect(
        withRequiredTransaction(runtime, (tx) =>
          fenceFamilyWorkspace(tx, runtime.agentId),
        ),
      ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
    } finally {
      release();
    }
    await work;
    const rows = await db.query(
      "SELECT state,receipt_json FROM app_lifeops.life_school_calendar_apply_operations",
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.state).toBe("applied");
      expect(row.receipt_json).not.toBeNull();
    }
    await withRequiredTransaction(runtime, (tx) =>
      fenceFamilyWorkspace(tx, runtime.agentId),
    );
  });

  it("retains application identity when the provider outcome is unknown", async () => {
    const result = await workflow.run();
    if (result.state !== "awaiting_approval")
      throw new Error("Expected a reviewable school run");
    const failedGateway: CalendarOwnerMutationGateway = {
      ...gateway,
      create: async () => {
        throw new Error("provider acknowledgement lost");
      },
    };
    await expect(
      workflow.applyApprovedPlan({
        runId: result.runId,
        gateway: failedGateway,
        requestUrl: new URL("http://localhost"),
      }),
    ).rejects.toThrow("provider acknowledgement lost");
    const rows = await db.query(
      "SELECT target_json FROM app_lifeops.life_family_workspace_operations",
    );
    expect(rows.rows).toEqual([
      {
        target_json: {
          kind: "school-calendar-work",
          sourceId: CONCORD_SCHOOL_CALENDAR_SOURCE.sourceId,
          runId: result.runId,
          phase: "apply",
        },
      },
    ]);
    await expect(
      withRequiredTransaction(runtime, (tx) =>
        fenceFamilyWorkspace(tx, runtime.agentId),
      ),
    ).rejects.toMatchObject({ code: "FAMILY_DELETION_WORK_UNSETTLED" });
  });

  it("uses saved elementary auto-apply settings and does not duplicate on a hash-equal rerun", async () => {
    text = [
      "2026-09-07 | Labor Day - no school",
      "2026-09-16 | CCHS early release",
      "2026-09-17 | CMS early release",
      "2026-11-06 | Elementary conferences",
      "2026-08-28 | 9th Grade Orientation",
      "2026-11-05 | PreK Conferences",
      "2027-06-05 | Graduation",
      "2026-10-28 | PreK-12 Early Release",
    ].join("\n");
    runtime.getService = ((name: string) =>
      name === CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE
        ? gateway
        : null) as IAgentRuntime["getService"];
    const service = new FamilyWorkflowRuntimeService(runtime, {
      schoolWorkflow: workflow,
    });
    await service.configureSchool({
      ...CONCORD_SCHOOL_CALENDAR_SOURCE,
      schoolLevel: "elementary",
      updateMode: "automatic",
    });
    expect((await service.runSchool("scheduled")).state).toBe("applied");
    expect(createdRanges.map((range) => range.title)).toEqual([
      "Labor Day - no school",
      "PreK-12 Early Release",
      "Elementary conferences",
    ]);
    expect((await service.runSchool("scheduled")).state).toBe("unchanged");
    expect(creates).toBe(3);
    const imported = await workflow.listImportedEvents();
    expect(imported.map((record) => record.event.title)).toEqual(
      createdRanges.map((range) => range.title),
    );
    expect(imported.every((record) => record.providerEventId.length > 0)).toBe(
      true,
    );
    const projectionFeed = {
      calendarId: "all",
      events: imported.map((record) => ({
        ...event(record.providerEventId, "Private calendar title"),
        grantId: record.grantId,
        calendarId: record.calendarId,
      })),
      state: "complete" as const,
      source: "synced" as const,
      sources: [],
      timeMin: "2026-09-01T00:00:00.000Z",
      timeMax: "2026-12-01T00:00:00.000Z",
      syncedAt: "2026-08-30T12:00:00.000Z",
    };
    const sharedClaims = collectCalendarClaims(projectionFeed, [], imported);
    expect(sharedClaims.map((claim) => claim.statement)).toEqual(
      createdRanges.map((range) => range.title),
    );
    expect(
      sharedClaims.every((claim) => claim.visibility === "guest_shareable"),
    ).toBe(true);
    await workflow.configure({
      ...CONCORD_SCHOOL_CALENDAR_SOURCE,
      schoolLevel: "elementary",
      updateMode: "automatic",
      packetVisibility: "owner_only",
    });
    const privateClaims = collectCalendarClaims(
      projectionFeed,
      [],
      await workflow.listImportedEvents(),
    );
    expect(
      privateClaims.every((claim) => claim.visibility === "owner_only"),
    ).toBe(true);
    expect(
      privateClaims.every(
        (claim) => claim.statement === "Private calendar title",
      ),
    ).toBe(true);
    const otherAgent = new SchoolCalendarWorkflow({
      ...runtime,
      agentId: "other-agent" as IAgentRuntime["agentId"],
    });
    expect(await otherAgent.listImportedEvents()).toEqual([]);
  });

  it("removes previously imported other-grade events despite identical PDF bytes", async () => {
    text = "2026-08-28 | 9th Grade Orientation\n2026-09-07 | Labor Day";
    const initial = await workflow.run();
    if (initial.state !== "awaiting_approval")
      throw new Error("expected initial plan");
    await workflow.applyApprovedPlan({
      runId: initial.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    const config = {
      ...CONCORD_SCHOOL_CALENDAR_SOURCE,
      schoolLevel: "elementary" as const,
    };
    await workflow.configure(config);
    await db.query(
      "UPDATE app_lifeops.life_school_calendar_sources SET calendar_contract_version=2,last_content_sha256=$1",
      [hash(pdfBytes)],
    );
    const correction = await workflow.run(config, "scheduled");
    if (correction.state !== "awaiting_approval")
      throw new Error("expected correction despite equal hash");
    expect(correction.plan.changes.map((change) => change.kind).sort()).toEqual(
      ["cancel", "unchanged"],
    );
    const cancel = vi.spyOn(gateway, "cancel");
    await workflow.applyApprovedPlan({
      runId: correction.runId,
      config,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(updatedRanges).toEqual([]);
    expect(creates).toBe(2);
    expect(
      (await workflow.listImportedEvents()).map((record) => record.event.title),
    ).toEqual(["Labor Day"]);
    expect((await workflow.run(config, "scheduled")).state).toBe("unchanged");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reprocesses unchanged PDF bytes when school selection changes", async () => {
    text =
      "2026-09-07 | Labor Day - no school\n2026-09-16 | CCHS early release";
    const first = await workflow.run();
    if (first.state !== "awaiting_approval") throw new Error("expected plan");
    await workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    const config = {
      ...CONCORD_SCHOOL_CALENDAR_SOURCE,
      schoolLevel: "elementary" as const,
    };
    await workflow.configure(config);
    const second = await workflow.run(config);
    expect(second.state).toBe("awaiting_approval");
    if (second.state !== "awaiting_approval") throw new Error("expected plan");
    expect(second.plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "cancel",
          event: expect.objectContaining({ title: "CCHS early release" }),
        }),
      ]),
    );
    await expect(
      workflow.applyApprovedPlan({
        runId: second.runId,
        requestUrl: new URL("http://localhost"),
        gateway,
      }),
    ).rejects.toMatchObject({ code: "SCHOOL_CALENDAR_CONFIG_CHANGED" });
  });

  it("runs source to retained hash to approval plan, applies through the gateway, then records hash-equal no-op", async () => {
    const first = await workflow.run();
    expect(first.state).toBe("awaiting_approval");
    if (first.state !== "awaiting_approval") throw new Error("expected plan");
    expect(first.plan.changes.map((change) => change.kind)).toEqual([
      "add",
      "add",
    ]);
    expect(first.plan.mediaUrl).toBe(`/api/media/${hash(pdfBytes)}.pdf`);
    await workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost/api/lifeops/calendar/events"),
      gateway,
    });
    expect(creates).toBe(2);

    const restarted = new SchoolCalendarWorkflow(runtime, {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedFetchImpl: async ({ url }) =>
        url.pathname.endsWith(".pdf")
          ? new Response(responseBody(pdfBytes), {
              headers: { "content-type": "application/pdf" },
            })
          : new Response(landing, { headers: { "content-type": "text/html" } }),
      extractPdfText: async () => text,
      retainPdf: async (bytes) => ({
        url: `/api/media/${hash(bytes)}.pdf`,
        hash: hash(bytes),
      }),
      now: () => new Date("2026-09-30T12:00:00.000Z"),
    });
    await expect(restarted.run(undefined, "scheduled")).resolves.toMatchObject({
      state: "unchanged",
      contentSha256: hash(pdfBytes),
    });
  });

  it("records a metadata-only PDF change as semantic no-op", async () => {
    const first = await workflow.run();
    if (first.state !== "awaiting_approval") throw new Error("expected plan");
    await workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    pdfBytes = Buffer.from("%PDF-concord-fixture-b-metadata-only");
    const second = await workflow.run();
    expect(second).toMatchObject({
      state: "unchanged",
      contentSha256: hash(pdfBytes),
    });
    expect(creates).toBe(2);
  });

  it("sends civil all-day ranges across standard and daylight time", async () => {
    text = ["2026-01-15 | Winter event", "Summer event | 2026-07-15"].join(
      "\n",
    );
    const first = await workflow.run();
    if (first.state !== "awaiting_approval") throw new Error("expected plan");

    await workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });

    expect(createdRanges).toEqual([
      {
        title: "Winter event",
        startAt: undefined,
        endAt: undefined,
        allDay: {
          startDate: "2026-01-15",
          endDateExclusive: "2026-01-16",
        },
      },
      {
        title: "Summer event",
        startAt: undefined,
        endAt: undefined,
        allDay: {
          startDate: "2026-07-15",
          endDateExclusive: "2026-07-16",
        },
      },
    ]);
  });

  it("creates a reviewable one-time migration for legacy timed school rows, then returns to hash no-op", async () => {
    const first = await workflow.run();
    if (first.state !== "awaiting_approval") throw new Error("expected plan");
    await workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    await db.exec(
      "UPDATE app_lifeops.life_school_calendar_sources SET calendar_contract_version = 1",
    );

    const migration = await workflow.run(undefined, "scheduled");
    expect(migration.state).toBe("awaiting_approval");
    if (migration.state !== "awaiting_approval") {
      throw new Error("expected migration plan");
    }
    expect(migration.plan.calendarContractVersion).toBe(3);
    expect(migration.plan.changes.map((change) => change.kind)).toEqual([
      "update",
      "update",
    ]);
    await workflow.applyApprovedPlan({
      runId: migration.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    expect(updatedRanges).toEqual([
      {
        eventId: "provider-1",
        allDay: { startDate: "2026-09-01", endDateExclusive: "2026-09-02" },
      },
      {
        eventId: "provider-2",
        allDay: { startDate: "2026-10-09", endDateExclusive: "2026-10-10" },
      },
    ]);
    await expect(workflow.run(undefined, "scheduled")).resolves.toMatchObject({
      state: "unchanged",
      contentSha256: hash(pdfBytes),
    });
  });

  it("rejects a concurrent apply owner while the first lease is active", async () => {
    const first = await workflow.run();
    if (first.state !== "awaiting_approval") throw new Error("expected plan");
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCreate = gateway.create.bind(gateway);
    gateway.create = vi.fn(async (...args) => {
      await blocked;
      return originalCreate(...args);
    });
    const applying = workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    await vi.waitFor(async () => {
      const row = await db.query<{ state: string }>(
        "SELECT state FROM app_lifeops.life_school_calendar_runs",
      );
      expect(row.rows[0]?.state).toBe("applying");
    });
    await expect(
      workflow.applyApprovedPlan({
        runId: first.runId,
        requestUrl: new URL("http://localhost"),
        gateway,
      }),
    ).rejects.toMatchObject({ code: "SCHOOL_CALENDAR_APPLY_IN_PROGRESS" });
    await expect(
      workflow.configure({
        ...CONCORD_SCHOOL_CALENDAR_SOURCE,
        schoolLevel: "elementary",
      }),
    ).rejects.toMatchObject({ code: "SCHOOL_CALENDAR_CONFIG_BUSY" });
    release();
    await applying;
  });

  it("releases a failed apply immediately and retries without replaying completed operations", async () => {
    const first = await workflow.run();
    if (first.state !== "awaiting_approval") throw new Error("expected plan");
    const successfulKeys: string[] = [];
    gateway.create = vi.fn(async (_url, request) => {
      successfulKeys.push(request.idempotencyKey);
      if (successfulKeys.length === 2) throw new Error("provider unavailable");
      return {
        outcome: "event",
        event: event(`provider-${successfulKeys.length}`, request.title),
        writeOnlyReceipt: null,
      };
    });
    await expect(
      workflow.applyApprovedPlan({
        runId: first.runId,
        requestUrl: new URL("http://localhost"),
        gateway,
      }),
    ).rejects.toThrow("provider unavailable");
    const operationStates = await db.query<{ state: string }>(
      "SELECT state FROM app_lifeops.life_school_calendar_apply_operations ORDER BY operation_index",
    );
    expect(operationStates.rows.map((row) => row.state)).toEqual([
      "applied",
      "pending",
    ]);
    const failedRun = await db.query<{
      state: string;
      apply_lease_token: string | null;
      error_code: string | null;
    }>(
      "SELECT state, apply_lease_token, error_code FROM app_lifeops.life_school_calendar_runs",
    );
    expect(failedRun.rows).toEqual([
      {
        state: "awaiting_approval",
        apply_lease_token: null,
        error_code: "SCHOOL_CALENDAR_APPLY_FAILED",
      },
    ]);

    gateway.create = vi.fn(async (_url, request) => {
      successfulKeys.push(request.idempotencyKey);
      return {
        outcome: "event",
        event: event("provider-2", request.title),
        writeOnlyReceipt: null,
      };
    });
    await workflow.applyApprovedPlan({
      runId: first.runId,
      requestUrl: new URL("http://localhost"),
      gateway,
    });
    expect(gateway.create).toHaveBeenCalledTimes(1);
    expect(successfulKeys[1]).toBe(successfulKeys[2]);
    const run = await db.query<{
      state: string;
      error_code: string | null;
    }>("SELECT state, error_code FROM app_lifeops.life_school_calendar_runs");
    expect(run.rows[0]).toEqual({ state: "applied", error_code: null });
  });

  it("isolates source state by agent ownership", async () => {
    const first = await workflow.run();
    expect(first.state).toBe("awaiting_approval");
    const other = { ...runtime, agentId: "agent-b" } as IAgentRuntime;
    const otherWorkflow = new SchoolCalendarWorkflow(other, {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedFetchImpl: async ({ url }) =>
        url.pathname.endsWith(".pdf")
          ? new Response(responseBody(pdfBytes), {
              headers: { "content-type": "application/pdf" },
            })
          : new Response(landing, { headers: { "content-type": "text/html" } }),
      extractPdfText: async () => text,
      retainPdf: async (bytes) => ({
        url: `/api/media/${hash(bytes)}.pdf`,
        hash: hash(bytes),
      }),
    });
    const otherResult = await otherWorkflow.run();
    expect(otherResult.state).toBe("awaiting_approval");
  });

  it("leases concurrent runs and permits restart after an expired crash lease", async () => {
    await workflow.ensureSchema();
    await db.exec(`INSERT INTO app_lifeops.life_school_calendar_sources
      (agent_id, source_id, config_json, lease_token, lease_expires_at, created_at, updated_at)
      VALUES ('agent-a', '${CONCORD_SCHOOL_CALENDAR_SOURCE.sourceId}', '{}', 'crashed',
      '2026-08-30T11:00:00.000Z', '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:00.000Z')`);
    const recovered = await workflow.run();
    expect(recovered.state).toBe("awaiting_approval");
    await db.exec(
      `UPDATE app_lifeops.life_school_calendar_sources SET lease_token = 'live', lease_expires_at = '2026-08-30T13:00:00.000Z' WHERE agent_id = 'agent-a'`,
    );
    await expect(workflow.run()).resolves.toEqual({
      state: "already_running",
      runId: null,
    });
  });

  it("records ambiguity as a failed run and releases the lease", async () => {
    text = "2026-09-01 | First day\nFirst day | 2026-09-01";
    await expect(workflow.run()).rejects.toMatchObject({
      code: "SCHOOL_CALENDAR_PARSE_AMBIGUOUS",
    });
    const rows = await db.query<{ state: string; error_code: string }>(
      "SELECT state, error_code FROM app_lifeops.life_school_calendar_runs",
    );
    expect(rows.rows).toEqual([
      { state: "failed", error_code: "SCHOOL_CALENDAR_PARSE_AMBIGUOUS" },
    ]);
    text = twoColumnText;
    await expect(workflow.run()).resolves.toMatchObject({
      state: "awaiting_approval",
    });
  });

  it("rejects a malicious source URL before any fetch", async () => {
    await expect(
      workflow.run({
        ...CONCORD_SCHOOL_CALENDAR_SOURCE,
        landingPageUrl: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toBeInstanceOf(SchoolCalendarWorkflowError);
  });
});
