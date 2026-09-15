/** Exercises server-derived review decisions against deterministic account/calendar boundaries, including forged facts and foreign sources. */
import type {
  LifeOpsCalendarSummary,
  LifeOpsLinkedCalendarLink,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import { deriveAccountHandoffGoogleReview } from "./account-handoff-google-review.js";

function fixture() {
  const f = googleHandoffFixture();
  const old = {
    ...f.status,
    grant: {
      ...f.grant,
      id: "old-grant",
      connectorAccountId: "old-account",
      identityEmail: "old@example.test",
    },
  };
  const accounts = [old, f.status];
  const source: LifeOpsCalendarSummary = {
    provider: "google",
    side: "owner",
    grantId: f.grant.id,
    connectorAccountId: f.grant.connectorAccountId,
    accountEmail: f.grant.identityEmail,
    calendarId: "family",
    summary: "Family",
    description: null,
    primary: false,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/New_York",
    selected: true,
    includeInFeed: false,
    selectionVersion: 2,
  };
  const link: LifeOpsLinkedCalendarLink = {
    id: "local-link",
    localEventId: "local-event",
    connectorAccountId: "old-account",
    providerCalendarId: "old-calendar",
    providerEventId: "old-provider-event",
    providerEtag: "etag",
    localRevision: 9,
    state: "clean",
    pendingOperation: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
  };
  const choices = {
    previousGrantId: "old-grant",
    replacementGrantId: f.grant.id,
    readCalendarIds: ["family"],
    writeCalendarId: "family",
    calendarLinks: [
      {
        linkId: "local-link",
        expectedUpdatedAt: link.updatedAt,
        expectedLocalRevision: link.localRevision,
        disposition: "copy_to_replacement" as const,
      },
    ],
  };
  let reads = 0;
  const run = (
    input: Parameters<typeof deriveAccountHandoffGoogleReview>[2] = choices,
  ) =>
    deriveAccountHandoffGoogleReview(
      "agent",
      new URL("http://localhost"),
      input,
      {
        getGoogleConnectorAccounts: async () => {
          reads++;
          return accounts;
        },
      },
      {
        listCalendars: async () => [source],
        listLinkedCalendarEvents: async () => [link],
      },
    );
  return { f, old, source, link, choices, run, reads: () => reads };
}

describe("server-derived Google handoff review", () => {
  it("uses current account identities and event revisions rather than display names or client facts", async () => {
    const f = fixture();
    const reviewed = await f.run();
    expect(reviewed.previous).toEqual({
      grantId: "old-grant",
      connectorAccountId: "old-account",
      email: "old@example.test",
    });
    expect(reviewed.calendarLinks[0]).toMatchObject({
      expectedLocalRevision: 9,
      expectedUpdatedAt: f.link.updatedAt,
    });
    f.link.localRevision = 10;
    f.link.updatedAt = "2026-09-10T13:00:00Z";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    const refreshed = await f.run({
      ...f.choices,
      calendarLinks: f.choices.calendarLinks.map((choice) => ({
        ...choice,
        expectedLocalRevision: f.link.localRevision,
        expectedUpdatedAt: f.link.updatedAt,
      })),
    });
    expect(refreshed.calendarLinks[0]).toMatchObject({
      expectedLocalRevision: 10,
      expectedUpdatedAt: f.link.updatedAt,
    });
    expect(reviewed.calendarLinks[0]?.expectedLocalRevision).toBe(9);
  });
  it("rejects supplied account facts before querying connections", async () => {
    const f = fixture();
    const forged = {
      ...f.choices,
      replacement: { email: "attacker@example.test" },
    };
    await expect(f.run(forged)).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    expect(f.reads()).toBe(0);
  });
  it("requires every old-account link and rejects another account's link", async () => {
    const f = fixture();
    await expect(
      f.run({ ...f.choices, calendarLinks: [] }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED" });
    f.link.connectorAccountId = "another-account";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
  });
  it("rejects a foreign calendar even when its calendar ID matches", async () => {
    const f = fixture();
    f.source.connectorAccountId = "another-account";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
  });
  it("requires both OAuth write capability and writable calendar access", async () => {
    const f = fixture();
    f.f.grant.capabilities = f.f.grant.capabilities.filter(
      (capability) => capability !== "google.calendar.write",
    );
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    f.f.grant.capabilities.push("google.calendar.write");
    f.source.accessRole = "reader";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
  });
  it("rejects a disconnected, foreign-agent or non-owner account", async () => {
    const f = fixture();
    f.old.connected = false;
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    f.old.connected = true;
    f.old.grant.agentId = "another-agent";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    f.old.grant.agentId = "agent";
    f.old.grant.side = "agent";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
  });
  it("requires a fresh review when an event changes after the owner loaded its choices", async () => {
    const f = fixture();
    f.link.localRevision++;
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    f.link.localRevision--;
    f.link.updatedAt = "2026-09-11T00:00:00Z";
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
    const refreshed = {
      ...f.choices,
      calendarLinks: f.choices.calendarLinks.map((choice) => ({
        ...choice,
        expectedUpdatedAt: f.link.updatedAt,
        expectedLocalRevision: f.link.localRevision,
      })),
    };
    expect((await f.run(refreshed)).calendarLinks[0]).toMatchObject({
      expectedUpdatedAt: f.link.updatedAt,
      expectedLocalRevision: f.link.localRevision,
    });
  });

  it("allows retaining local events with read-only access but refuses copying without a destination", async () => {
    const f = fixture();
    f.f.grant.capabilities = ["google.calendar.read"];
    f.source.accessRole = "reader";
    const input = {
      ...f.choices,
      writeCalendarId: null,
      calendarLinks: [
        {
          linkId: f.link.id,
          expectedUpdatedAt: f.link.updatedAt,
          expectedLocalRevision: f.link.localRevision,
          disposition: "retain_local" as const,
        },
      ],
    };
    const reviewed = await f.run(input);
    expect(reviewed.writeCalendar).toBeNull();
    expect(reviewed.calendarLinks[0]?.disposition).toBe("retain_local");
    await expect(
      f.run({
        ...input,
        calendarLinks: [
          {
            linkId: f.link.id,
            expectedUpdatedAt: f.link.updatedAt,
            expectedLocalRevision: f.link.localRevision,
            disposition: "copy_to_replacement",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    });
  });
});
