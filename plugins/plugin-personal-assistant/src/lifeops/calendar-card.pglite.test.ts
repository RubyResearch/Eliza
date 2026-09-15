/**
 * Integration-backed calendar-card tests use real PGlite lifecycle rows and a
 * deterministic private-media adapter; no connector sends or external effects
 * occur.
 */

import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, IFileStorageService } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CalendarCardAccessError,
  CalendarCardAccessStore,
  calendarCardApprovalPayload,
  calendarCardDeliveryStatus,
  composeDailyCalendarCard,
  verifyCalendarCardApproval,
} from "./calendar-card.js";
import type { RawSqlQuery } from "./sql.js";

const events = [
  {
    id: "later",
    startAt: "2026-09-02T19:00:00.000Z",
    endAt: "2026-09-02T20:00:00.000Z",
    title: "Soccer practice",
    location: "Field 2",
  },
  {
    id: "earlier",
    startAt: "2026-09-02T12:30:00.000Z",
    endAt: "2026-09-02T13:00:00.000Z",
    title: "School drop-off",
    location: "Concord School",
  },
] as const;

class MemoryPrivateFiles {
  readonly bytes = new Map<string, Buffer>();
  async storePrivate(value: Buffer | Uint8Array) {
    const bytes = Buffer.from(value);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const fileName = `${hash}.private-html`;
    this.bytes.set(fileName, bytes);
    return { hash, fileName, mimeType: "text/html", size: bytes.length };
  }
  async readPrivate(fileName: string) {
    return this.bytes.get(fileName) ?? null;
  }
  async deletePrivate(fileName: string) {
    return this.bytes.delete(fileName);
  }
}

describe("daily calendar card composition", () => {
  it("is deterministic and applies each privacy mode before hashing", () => {
    const full = composeDailyCalendarCard({
      date: "2026-09-02",
      timeZone: "America/New_York",
      privacyMode: "full",
      events,
      accessUrl: "https://eliza.test/card?token=fixed",
    });
    const replay = composeDailyCalendarCard({
      date: "2026-09-02",
      timeZone: "America/New_York",
      privacyMode: "full",
      events: [...events].reverse(),
      accessUrl: "https://eliza.test/card?token=fixed",
    });
    const busy = composeDailyCalendarCard({
      date: "2026-09-02",
      timeZone: "America/New_York",
      privacyMode: "busy_only",
      events,
      accessUrl: "https://eliza.test/card?token=fixed",
    });

    expect(replay).toEqual(full);
    expect(full.html).toContain("School drop-off");
    expect(full.html.indexOf("School drop-off")).toBeLessThan(
      full.html.indexOf("Soccer practice"),
    );
    expect(busy.html).not.toContain("School drop-off");
    expect(busy.html).not.toContain("Concord School");
    expect(full).toMatchObject({
      htmlSha256:
        "253dcc63cede9f3fba42ee4e512f58763f2920f67483b177d9af7a2f01d4ab1d",
      textSha256:
        "967765d464e71ed2835f7415d519b340ce57cdcaf6f193ca63b0e268fa39a7b3",
      envelopeSha256:
        "05a7debb585d75b067dcb94b8e9333c6e5ab34ce2ba2d75141b9e943583a4835",
    });
  });

  it("detects exact approved text tampering", () => {
    const composition = composeDailyCalendarCard({
      date: "2026-09-02",
      timeZone: "America/New_York",
      privacyMode: "times_only",
      events,
      accessUrl: "https://eliza.test/card?token=fixed",
    });
    const payload = calendarCardApprovalPayload({
      recipient: "+15555550123",
      recipientEntityId: "owner-1",
      cardId: "card-1",
      composition,
    });
    expect(verifyCalendarCardApproval(payload)?.matches).toBe(true);
    expect(
      verifyCalendarCardApproval({ ...payload, body: `${payload.body}!` })
        ?.matches,
    ).toBe(false);
    expect(
      verifyCalendarCardApproval({
        ...payload,
        calendarCard: payload.calendarCard
          ? { ...payload.calendarCard, privacyMode: "full" }
          : undefined,
      })?.matches,
    ).toBe(false);
  });

  it.each(["imessage", "telegram", "discord"] as const)(
    "binds a %s card review to its exact recipient and transport",
    (channel) => {
      const composition = composeDailyCalendarCard({
        date: "2026-09-02",
        timeZone: "America/New_York",
        privacyMode: "times_only",
        events,
        accessUrl: "https://eliza.test/card?token=fixed",
      });
      const payload = calendarCardApprovalPayload({
        channel,
        sender: {
          channel,
          side: channel === "imessage" ? "owner" : "agent",
          transport: "test-transport",
          accountId: "test-account",
          identityId: "test-identity",
          displayName: "Test sender",
        },
        recipient: "approved-destination",
        recipientEntityId: "owner-1",
        cardId: "card-1",
        composition,
      });
      expect(verifyCalendarCardApproval(payload)?.matches).toBe(true);
      expect(
        verifyCalendarCardApproval({
          ...payload,
          recipient: "another-destination",
        })?.matches,
      ).toBe(false);
      const correlation = payload.calendarCard;
      if (correlation?.version !== 4)
        throw new Error("Missing bound card review");
      expect(
        verifyCalendarCardApproval({
          ...payload,
          calendarCard: {
            ...correlation,
            sender: { ...correlation.sender, identityId: "unreviewed-account" },
          },
        })?.matches,
      ).toBe(false);

      expect(
        verifyCalendarCardApproval({
          ...payload,
          calendarCard: {
            ...correlation,
            channel: channel === "telegram" ? "discord" : "telegram",
          },
        })?.matches,
      ).toBe(false);
      expect(
        verifyCalendarCardApproval({
          ...payload,
          calendarCard: { ...correlation, recipientEntityId: "another-person" },
        })?.matches,
      ).toBe(false);
      expect(
        verifyCalendarCardApproval({
          ...payload,
          calendarCard: { ...correlation, ownerEntityId: "another-owner" },
        })?.matches,
      ).toBe(false);
    },
  );

  it("does not equate provider acceptance with recipient delivery", () => {
    expect(calendarCardDeliveryStatus({ accepted: true })).toEqual({
      state: "accepted",
      providerReceipt: null,
      delivered: null,
    });
    expect(
      calendarCardDeliveryStatus({
        accepted: true,
        providerReceipt: { provider: "imessage", messageId: "m-1" },
      }),
    ).toMatchObject({ state: "provider_receipt", delivered: null });
    expect(
      calendarCardDeliveryStatus({
        accepted: false,
        outcomeUnknown: true,
        providerReceipt: { provider: "blooio", requestId: "r-1" },
      }),
    ).toMatchObject({ state: "unknown", delivered: null });
  });
});

describe("CalendarCardAccessStore", () => {
  let db: PGlite;
  let files: MemoryPrivateFiles;
  let store: CalendarCardAccessStore;
  let now: Date;

  beforeEach(async () => {
    db = await PGlite.create();
    files = new MemoryPrivateFiles();
    now = new Date("2026-09-01T12:00:00.000Z");
    const runtime = {
      agentId: "agent-1",
      getService: () => files as unknown as IFileStorageService,
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) => {
            const sql = query.queryChunks
              .map((chunk) => chunk.value ?? "")
              .join("");
            return db.query(sql);
          },
        },
      },
    } as unknown as IAgentRuntime;
    store = new CalendarCardAccessStore(runtime, () => now);
  });

  it("denies wrong identity, expires, and consumes exactly once", async () => {
    const issued = await store.issue({
      recipientEntityId: "owner-1",
      html: "<html>private</html>",
      ttlMs: 60_000,
      baseUrl: "https://eliza.test",
    });
    const token = new URL(issued.accessUrl).searchParams.get("token") ?? "";

    await expect(
      store.consume({
        cardId: issued.cardId,
        token,
        principalEntityId: "guest-1",
      }),
    ).rejects.toMatchObject({
      code: "CARD_ACCESS_WRONG_IDENTITY",
      status: 403,
    });
    await expect(
      store.consume({
        cardId: issued.cardId,
        token,
        principalEntityId: "owner-1",
      }),
    ).resolves.toEqual(Buffer.from("<html>private</html>"));
    await expect(
      store.consume({
        cardId: issued.cardId,
        token,
        principalEntityId: "owner-1",
      }),
    ).rejects.toMatchObject({ code: "CARD_ACCESS_REPLAY", status: 410 });

    const expired = await store.issue({
      recipientEntityId: "owner-1",
      html: "<html>expired</html>",
      ttlMs: 1,
      baseUrl: "https://eliza.test",
    });
    now = new Date(now.getTime() + 2);
    await expect(
      store.consume({
        cardId: expired.cardId,
        token: new URL(expired.accessUrl).searchParams.get("token") ?? "",
        principalEntityId: "owner-1",
      }),
    ).rejects.toBeInstanceOf(CalendarCardAccessError);
  });

  it("revokes access and cleans private bytes without exposing a media URL", async () => {
    const issued = await store.issue({
      recipientEntityId: "owner-1",
      html: "<html>revoked</html>",
      ttlMs: 60_000,
      baseUrl: "https://eliza.test",
    });
    expect([...files.bytes.keys()][0]).toMatch(/\.private-html$/);
    expect(issued).not.toHaveProperty("mediaUrl");
    await expect(store.revoke(issued.cardId)).resolves.toBe(true);
    expect(files.bytes.size).toBe(0);
  });

  it("garbage-collects expired unopened card rows and their private bytes", async () => {
    await store.issue({
      recipientEntityId: "guest-1",
      html: "<html>expired unopened</html>",
      ttlMs: 1,
      baseUrl: "https://eliza.test",
    });
    expect(files.bytes.size).toBe(1);
    now = new Date(now.getTime() + 2);

    await expect(store.cleanup()).resolves.toBe(1);
    expect(files.bytes.size).toBe(0);
    const rows = await db.query(
      "SELECT card_id FROM app_lifeops.life_calendar_card_access",
    );
    expect(rows.rows).toEqual([]);
  });

  it("rejects private-byte tampering before an approved send", async () => {
    const issued = await store.issue({
      recipientEntityId: "owner-1",
      html: "<html>approved</html>",
      ttlMs: 60_000,
      baseUrl: "https://eliza.test",
    });
    const [fileName] = files.bytes.keys();
    files.bytes.set(fileName, Buffer.from("<html>tampered</html>"));
    await expect(
      store.verifyApprovedBytes({
        kind: "calendar_card",
        version: 1,
        cardId: issued.cardId,
        recipientEntityId: "owner-1",
        date: "2026-09-01",
        timeZone: "America/New_York",
        privacyMode: "full",
        textSha256: "0".repeat(64),
        htmlSha256: issued.htmlSha256,
        envelopeSha256: "1".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CARD_BYTES_TAMPERED" });
  });
});
