/**
 * Deterministic coverage for the travel-origin guard: the outer planner stamps
 * `travelOriginAddress` onto ordinary creates, and the buffer prep then fails
 * the create for want of a destination. Only the user's own words open the
 * travel path.
 */
import { describe, expect, it } from "vitest";
import {
  impliedMutationTargetHint,
  intentStatesTravel,
  isTitleEchoLocation,
} from "./calendar-handler";

describe("intentStatesTravel", () => {
  it("rejects a plain create carrying a fabricated origin (live regression)", () => {
    // Live 2026-09-12: "add a optometrist appointment friday at 3pm to my
    // calendar" arrived with travelOriginAddress "Eliza Calendar" and the
    // turn asked the user for an address instead of creating the event.
    expect(
      intentStatesTravel(
        "Eliza Calendar",
        "add a optometrist appointment friday at 3pm to my calendar",
      ),
    ).toBe(false);
    expect(intentStatesTravel("123 Main St", "dentist tomorrow at 3pm")).toBe(
      false,
    );
    // Bare travel vocabulary is not a travel-time request.
    expect(intentStatesTravel("the depot", "add a driving lesson at 3pm")).toBe(
      false,
    );
    expect(intentStatesTravel("home", "book the transit strike briefing")).toBe(
      false,
    );
    expect(intentStatesTravel(undefined, "")).toBe(false);
  });

  it("rejects an origin the planner copied out of the event title", () => {
    // Live 2026-09-14: travelOriginAddress "Barber" on "add a barber
    // appointment friday at 3pm to my calendar" passed the containment test
    // and the create was refused for want of a Routes API key.
    expect(
      intentStatesTravel(
        "Barber",
        "add a barber appointment friday at 3pm to my calendar",
      ),
    ).toBe(false);
    expect(intentStatesTravel("dentist", "dentist at 3pm friday")).toBe(false);
    expect(
      intentStatesTravel("123 Main St", "dentist at 3pm from 123 Main St"),
    ).toBe(true);
    expect(
      intentStatesTravel("the (old) office", "leaving the (old) office at 2"),
    ).toBe(true);
  });

  it("keeps travel when the user asks for it or names the departure place", () => {
    expect(
      intentStatesTravel(
        "the office",
        "add dentist at 3pm friday, I'm leaving from the office",
      ),
    ).toBe(true);
    expect(
      intentStatesTravel(
        "123 Main St",
        "book the vet at 4pm and add travel time from 123 Main St",
      ),
    ).toBe(true);
    expect(
      intentStatesTravel("home", "gym at 6, how long does it take from home?"),
    ).toBe(true);
  });
});

describe("isTitleEchoLocation", () => {
  it("drops a location that repeats the user's own event noun", () => {
    expect(
      isTitleEchoLocation("Barber", "Barber", [
        "add a barber appointment friday at 3pm to my calendar",
      ]),
    ).toBe(true);
    expect(
      isTitleEchoLocation("Barber", "Barber appointment", [
        "add a barber appointment friday at 3pm",
      ]),
    ).toBe(true);
  });

  it("keeps a location beside a planner-authored title the user never said", () => {
    expect(
      isTitleEchoLocation("Unknown", "Unknown", [
        "Add soccer practice with travel from home",
      ]),
    ).toBe(false);
    expect(isTitleEchoLocation("Main St gym", "Gym", ["gym at 6"])).toBe(false);
    expect(isTitleEchoLocation(undefined, "Gym", ["gym at 6"])).toBe(false);
  });
});

describe("impliedMutationTargetHint", () => {
  it("names the event between the verb and the first time or place clause", () => {
    expect(
      impliedMutationTargetHint(
        "move my chiropractor appointment to friday at 4pm",
      ),
    ).toBe("chiropractor appointment");
    expect(
      impliedMutationTargetHint(
        "delete the chiropractor appointment from my calendar",
      ),
    ).toBe("chiropractor appointment");
    expect(impliedMutationTargetHint("cancel my 3pm dentist")).toBe("dentist");
    expect(
      impliedMutationTargetHint("please reschedule dentist to next tuesday"),
    ).toBe("dentist");
  });

  it("returns nothing for requests that are not mutations or name no event", () => {
    expect(impliedMutationTargetHint("add a haircut friday at 2pm")).toBe(
      undefined,
    );
    expect(impliedMutationTargetHint("move it to 5pm")).toBe(undefined);
    expect(impliedMutationTargetHint("change its start time")).toBe(undefined);
    expect(impliedMutationTargetHint("delete that one")).toBe(undefined);
    expect(impliedMutationTargetHint("cancel 3pm")).toBe(undefined);
    expect(impliedMutationTargetHint("")).toBe(undefined);
    expect(impliedMutationTargetHint(undefined)).toBe(undefined);
  });
});
