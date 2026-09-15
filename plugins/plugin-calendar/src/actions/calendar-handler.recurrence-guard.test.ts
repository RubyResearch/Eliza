/**
 * Deterministic coverage for the explicit-recurrence guard on model-inferred
 * RRULEs: cadence-flavored event nouns ("standup") and time-of-day window
 * phrases ("in the morning") must not become repeating events; explicit
 * recurrence in any supported language must keep them. Every model-authored
 * recurrence source is gated by current authoritative user text.
 */
import { describe, expect, it } from "vitest";
import {
  buildCreateEventRequest,
  intentStatesRecurrence,
} from "./calendar-handler.js";

describe("intentStatesRecurrence", () => {
  it("rejects one-off asks with cadence-flavored nouns", () => {
    // Live repro: the extraction model emitted RRULE:FREQ=WEEKLY;BYDAY=MO for
    // this exact ask and the built-in calendar hard-400'd on recurrence.
    expect(
      intentStatesRecurrence("add to my calendar: standup monday at 10am"),
    ).toBe(false);
    expect(intentStatesRecurrence("dentist appointment tomorrow at 3pm")).toBe(
      false,
    );
    expect(intentStatesRecurrence("lunch with sam friday")).toBe(false);
  });

  it("rejects time-of-day window phrases in one-shot asks", () => {
    // Window phrases live in the lifeops_cadence doc for WINDOW extraction;
    // they are not recurrence statements and must not open the gate.
    expect(intentStatesRecurrence("remind me to call mom in the morning")).toBe(
      false,
    );
    expect(intentStatesRecurrence("dentist tomorrow in the morning")).toBe(
      false,
    );
    expect(intentStatesRecurrence("take out the trash before bed")).toBe(false);
    expect(intentStatesRecurrence("gym after work today")).toBe(false);
  });

  it("rejects name-like cadence words (title-cased daily/diario)", () => {
    expect(
      intentStatesRecurrence("Daily Planet interview tomorrow at 3pm"),
    ).toBe(false);
    expect(intentStatesRecurrence("recuérdame comprar el Diario mañana")).toBe(
      false,
    );
  });

  it("rejects quantifier uses of every/each", () => {
    expect(
      intentStatesRecurrence("invite every member to the launch party"),
    ).toBe(false);
    expect(
      intentStatesRecurrence("add each attendee to the meeting invite"),
    ).toBe(false);
  });

  it("accepts explicit English recurrence phrasings", () => {
    expect(intentStatesRecurrence("standup every monday at 10am")).toBe(true);
    expect(intentStatesRecurrence("gym weekly on wednesdays")).toBe(true);
    expect(intentStatesRecurrence("water the plants daily at 9")).toBe(true);
    expect(intentStatesRecurrence("team sync, repeats each friday")).toBe(true);
    expect(intentStatesRecurrence("recurring rent payment on the 1st")).toBe(
      true,
    );
    expect(intentStatesRecurrence("yoga on tuesdays")).toBe(true);
    expect(intentStatesRecurrence("review twice a week")).toBe(true);
    expect(intentStatesRecurrence("standup every other friday")).toBe(true);
    expect(intentStatesRecurrence("backup runs nightly")).toBe(true);
  });

  it("accepts explicit recurrence in the shipped locales", () => {
    expect(intentStatesRecurrence("reunión cada lunes a las 10")).toBe(true);
    expect(intentStatesRecurrence("gimnasio todos los martes")).toBe(true);
    expect(intentStatesRecurrence("academia todas as segundas")).toBe(true);
    expect(intentStatesRecurrence("họp mỗi tuần")).toBe(true);
    expect(intentStatesRecurrence("simba araw-araw")).toBe(true);
    expect(intentStatesRecurrence("每周一开站会")).toBe(true);
    expect(intentStatesRecurrence("天天锻炼")).toBe(true);
    expect(intentStatesRecurrence("월요일마다 스탠드업")).toBe(true);
    expect(intentStatesRecurrence("매주 회의")).toBe(true);
    expect(intentStatesRecurrence("gimnasio los martes a las 10")).toBe(true);
    expect(intentStatesRecurrence("una vez a la semana yoga")).toBe(true);
    expect(intentStatesRecurrence("toda segunda tem reunião")).toBe(true);
    expect(intentStatesRecurrence("周一到周五提醒我吃药")).toBe(true);
    expect(intentStatesRecurrence("毎週月曜日の午前10時にスタンドアップ")).toBe(
      true,
    );
  });

  it("rejects Japanese one-shot windows and name-like cadence words", () => {
    expect(intentStatesRecurrence("明日の朝、歯医者の予定を追加して")).toBe(
      false,
    );
    expect(intentStatesRecurrence("毎日新聞の取材を明日の朝に追加して")).toBe(
      false,
    );
  });

  it("rejects negated recurrence and non-user role text", () => {
    expect(intentStatesRecurrence("remind me tomorrow, not every day")).toBe(
      false,
    );
    expect(
      intentStatesRecurrence(
        "schedule standup Monday, not recurring, just once",
      ),
    ).toBe(false);
    expect(intentStatesRecurrence("assistant: should this be weekly?")).toBe(
      false,
    );
    expect(intentStatesRecurrence("back up every 2 days")).toBe(true);
    expect(intentStatesRecurrence("check every 15 minutes")).toBe(true);
  });

  it("is empty-safe", () => {
    expect(intentStatesRecurrence("")).toBe(false);
    expect(intentStatesRecurrence("   ")).toBe(false);
    expect(intentStatesRecurrence(undefined, null, "")).toBe(false);
  });
});

describe("buildCreateEventRequest recurrence authority", () => {
  const plannerRecurrence = ["RRULE:FREQ=WEEKLY;BYDAY=MO"];

  it("drops an outer-planner RRULE for a one-off raw user request", () => {
    const built = buildCreateEventRequest({
      details: {
        title: "standup",
        startAt: "2026-08-17T10:00:00.000Z",
        recurrence: plannerRecurrence,
      },
      extractedDetails: {},
      explicitTitle: "standup",
      inferredTitle: "standup",
      authorizingUserTexts: ["add to my calendar: standup monday at 10am"],
    });

    expect(built.request.recurrence).toBeUndefined();
    expect(built.request.startAt).toBe("2026-08-17T10:00:00.000Z");
  });

  it("drops an RRULE nested inside a negated recurrence clause", () => {
    const built = buildCreateEventRequest({
      details: { title: "standup", recurrence: plannerRecurrence },
      extractedDetails: { recurrence: plannerRecurrence },
      explicitTitle: "standup",
      inferredTitle: "weekly standup",
      authorizingUserTexts: ["do not repeat this every week"],
    });

    expect(built.request.recurrence).toBeUndefined();
  });

  it("keeps outer-planner recurrence when the current user states cadence", () => {
    const built = buildCreateEventRequest({
      details: { title: "standup", recurrence: plannerRecurrence },
      extractedDetails: {},
      explicitTitle: "standup",
      inferredTitle: "standup",
      authorizingUserTexts: ["schedule standup every monday at 10am"],
    });

    expect(built.request.recurrence).toEqual(plannerRecurrence);
  });

  it("does not let planner or assistant text open the gate", () => {
    const built = buildCreateEventRequest({
      details: { title: "standup", recurrence: plannerRecurrence },
      extractedDetails: { recurrence: plannerRecurrence },
      explicitTitle: "standup",
      inferredTitle: "weekly standup",
      authorizingUserTexts: [
        "user: no, just once\nassistant: should this be weekly?",
      ],
    });

    expect(built.request.recurrence).toBeUndefined();
  });
});
