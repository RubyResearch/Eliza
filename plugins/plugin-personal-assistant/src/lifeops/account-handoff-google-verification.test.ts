/** Exercises the real replacement verifier with deterministic external Google read ports. */
import { describe, expect, it } from "vitest";
import { googleHandoffFixture as fixture } from "../../test/helpers/handoff-google.js";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";

describe("reviewed Google handoff verification", () => {
  it("reads only the reviewed account and returns a scoped receipt", async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.calls).toEqual([
      "status:replacement-grant",
      "calendars:replacement",
      "gmail:replacement",
    ]);
    expect(result).toMatchObject({
      connectorAccountId: "replacement",
      grantId: "replacement-grant",
      calendarIds: ["reviewed-calendar"],
      writableCalendarId: "reviewed-calendar",
      gmailHistoryId: "12345",
    });
  });
  it.each(["agentId", "connectorAccountId", "identityEmail", "id"] as const)(
    "rejects changed %s before provider reads",
    async (field) => {
      const f = fixture();
      f.grant[field] = "different";
      await expect(f.run()).rejects.toMatchObject({
        code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
      });
      expect(f.calls).toEqual(["status:replacement-grant"]);
    },
  );
  it("rejects lost send permission without probing another account", async () => {
    const f = fixture();
    f.grant.capabilities = [
      "google.calendar.read",
      "google.calendar.write",
      "google.gmail.triage",
    ];
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(f.calls).toEqual(["status:replacement-grant"]);
  });
  it.each(["reader", "freeBusyReader"])(
    "rejects a destination downgraded to %s",
    async (accessRole) => {
      const f = fixture();
      f.entry.accessRole = accessRole;
      await expect(f.run()).rejects.toMatchObject({
        code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
      });
      expect(f.calls).not.toContain("gmail:replacement");
    },
  );
  it("rejects a deleted calendar and empty Gmail authorization probe", async () => {
    const f = fixture();
    f.entry.deleted = true;
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    f.entry.deleted = false;
    f.setHistory("");
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
  });
  it("does not issue provider-verification evidence from account metadata alone", async () => {
    const f = fixture();
    f.review.readCalendars = [];
    f.review.writeCalendar = null;
    f.review.messageDestinations = [];
    await expect(f.run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(f.calls).toEqual(["status:replacement-grant"]);
  });

  it("propagates a provider outage without returning a verification receipt", async () => {
    const f = fixture();
    const outage = new Error("Synthetic provider outage");
    await expect(
      verifyAccountHandoffGoogle(
        "agent",
        new URL("http://localhost"),
        f.review,
        f.accounts,
        {
          ...f.google,
          listCalendars: async () => {
            throw outage;
          },
        },
      ),
    ).rejects.toBe(outage);
  });
});
