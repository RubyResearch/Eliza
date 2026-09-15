import { describe, expect, it } from "vitest";
import {
  calendarUpdateTextField,
  isUngroundedTextField,
  looksLikePlaceholderToken,
  userRequestsFieldClear,
} from "./calendar-handler";

describe("looksLikePlaceholderToken", () => {
  it("recognises model spellings of no value (live regression: location N/A)", () => {
    for (const value of [
      "N/A",
      "n/a",
      " NA ",
      "none",
      "null",
      "unknown",
      "TBD",
      "-",
      "not specified",
      "not provided.",
    ]) {
      expect(looksLikePlaceholderToken(value)).toBe(true);
    }
  });

  it("keeps real places and notes", () => {
    for (const value of [
      "Dr. Chen's office",
      "Nantes",
      "Nonesuch Farm",
      "TBD Brewing Co",
      "bring the insurance card",
    ]) {
      expect(looksLikePlaceholderToken(value)).toBe(false);
    }
  });
});

describe("isUngroundedTextField", () => {
  const move = "move my tailor appointment to friday at 4pm";

  it("drops a place the user never said (live: 123 Main st)", () => {
    expect(
      isUngroundedTextField("123 Main st", "Tailor appointment", [move]),
    ).toBe(true);
  });

  it("drops an abbreviation of the event's own noun (live: chiro)", () => {
    expect(
      isUngroundedTextField("chiro", "Chiropractor appointment", [
        "move my chiropractor appointment to friday at 4pm",
      ]),
    ).toBe(true);
  });

  it("drops a note that only restates the title and the schedule", () => {
    expect(
      isUngroundedTextField("Vet appointment Friday 4pm", "Vet appointment", [
        "move my vet appointment to friday at 4pm",
      ]),
    ).toBe(true);
  });

  it("drops a note that restates the request (live: Move notary appointment to Friday at 4:00 PM)", () => {
    expect(
      isUngroundedTextField(
        "Move notary appointment to Friday at 4:00 PM",
        "Notary appointment",
        ["move my notary appointment to friday at 4pm"],
      ),
    ).toBe(true);
    expect(
      isUngroundedTextField("Dentist appointment", "Dentist", [
        "add a dentist appointment friday at 3pm to my calendar",
      ]),
    ).toBe(true);
    expect(
      isUngroundedTextField("Moving the meeting", "Budget sync", [
        "move the budget sync to 4pm",
      ]),
    ).toBe(true);
  });

  it("keeps a note whose substance the user said", () => {
    expect(
      isUngroundedTextField("Discuss the Q3 budget with Sam", "Budget sync", [
        "add a meeting with sam friday at 3 to discuss the q3 budget",
      ]),
    ).toBe(false);
  });

  it("keeps a place the user named on this turn", () => {
    expect(
      isUngroundedTextField("Dr. Chen's office", "Dentist appointment", [
        "move my dentist appointment to dr. chen's office at 4pm",
      ]),
    ).toBe(false);
  });

  it("keeps a paraphrase when one of its words is the user's", () => {
    expect(
      isUngroundedTextField("Mom's house", "Dinner", [
        "move dinner to my mom's at 7",
      ]),
    ).toBe(false);
  });

  it("matches abbreviations either way", () => {
    expect(
      isUngroundedTextField("5th Ave", "Dentist", ["move it to 5th avenue"]),
    ).toBe(false);
    expect(
      isUngroundedTextField("Chiropractor clinic", "Adjustment", [
        "add an adjustment at the chiro clinic on friday",
      ]),
    ).toBe(false);
  });

  it("grounds a short value exactly", () => {
    expect(isUngroundedTextField("LA", "Trip", ["move the trip to LA"])).toBe(
      false,
    );
    expect(
      isUngroundedTextField("LA", "Trip", ["move the trip to friday"]),
    ).toBe(true);
  });

  it("grounds through the user's earlier lines but not the agent's", () => {
    expect(
      isUngroundedTextField("Blue room", "Team sync", [
        "move it there",
        "the blue room on 3",
      ]),
    ).toBe(false);
    expect(
      isUngroundedTextField("Blue room", "Team sync", ["move it to 4pm"]),
    ).toBe(true);
  });

  it("judges nothing without user text", () => {
    expect(isUngroundedTextField("Blue room", "Team sync", [])).toBe(false);
    expect(isUngroundedTextField(undefined, "Team sync", ["anything"])).toBe(
      false,
    );
  });
});

describe("userRequestsFieldClear", () => {
  it("recognises a request to remove the place", () => {
    for (const text of [
      "remove the location from my dentist appointment",
      "clear its address",
      "get rid of the venue on the dinner",
      "set the location to none",
      "move it to friday with no location",
      "the location should be blank",
      "make it without a location",
    ]) {
      expect(userRequestsFieldClear("location", text)).toBe(true);
    }
  });

  it("recognises a request to remove the note", () => {
    for (const text of [
      "clear the notes on the dentist appointment",
      "remove the description",
      "drop the details from the meeting",
    ]) {
      expect(userRequestsFieldClear("description", text)).toBe(true);
    }
  });

  it("does not read a plain move, delete or new place as a clear (live regression)", () => {
    for (const text of [
      "move my chiropractor appointment to friday at 4pm",
      "delete the dentist appointment",
      "move it to the new location",
      "change the address to 5th avenue",
      "move it to 4pm without changing the location",
      undefined,
      "",
    ]) {
      expect(userRequestsFieldClear("location", text)).toBe(false);
      expect(userRequestsFieldClear("description", text)).toBe(false);
    }
  });
});

describe("calendarUpdateTextField", () => {
  const plainMove = "move my chiropractor appointment to friday at 4pm";
  const guards = {
    title: "Chiropractor appointment",
    requestText: plainMove,
    userTexts: [plainMove],
  };

  it("drops an unauthorized clear and the debris beside it without a conflict (live regression)", () => {
    expect(
      calendarUpdateTextField(
        { location: "chiro", clearFields: ["location"] },
        {},
        "location",
        guards,
      ),
    ).toBeUndefined();
  });

  it("drops placeholders and invented places", () => {
    expect(
      calendarUpdateTextField({ location: "N/A" }, {}, "location", guards),
    ).toBeUndefined();
    expect(
      calendarUpdateTextField(
        { location: "123 Main st" },
        {},
        "location",
        guards,
      ),
    ).toBeUndefined();
    expect(
      calendarUpdateTextField(
        { description: "Chiropractor appointment Friday 4pm" },
        {},
        "description",
        guards,
      ),
    ).toBeUndefined();
  });

  it("clears only when the user asked, even beside a replacement", () => {
    const removal = "remove the location from my chiropractor appointment";
    const removalGuards = {
      ...guards,
      requestText: removal,
      userTexts: [removal],
    };
    expect(
      calendarUpdateTextField(
        { clearFields: ["location"] },
        {},
        "location",
        removalGuards,
      ),
    ).toBe("");
    expect(
      calendarUpdateTextField(
        { location: "Old office", clearFields: ["location"] },
        {},
        "location",
        removalGuards,
      ),
    ).toBe("");
    expect(
      calendarUpdateTextField(
        { clearFields: ["location"] },
        {},
        "description",
        removalGuards,
      ),
    ).toBeUndefined();
  });

  it("keeps a place the user named and falls back to the extraction", () => {
    const named = "move my chiropractor appointment to dr. chen's office";
    expect(
      calendarUpdateTextField(
        { location: "Dr. Chen's office" },
        {},
        "location",
        { ...guards, requestText: named, userTexts: [named] },
      ),
    ).toBe("Dr. Chen's office");
    const note =
      "add a note to bring the insurance card to my chiropractor appointment";
    expect(
      calendarUpdateTextField(
        {},
        { description: "bring the insurance card" },
        "description",
        { ...guards, requestText: note, userTexts: [note] },
      ),
    ).toBe("bring the insurance card");
  });

  it("grounds through an earlier user line only for the value, not the clear", () => {
    const earlier = "the new office is on 5th avenue";
    expect(
      calendarUpdateTextField({ location: "5th Ave office" }, {}, "location", {
        ...guards,
        userTexts: [plainMove, earlier],
      }),
    ).toBe("5th Ave office");
    expect(
      calendarUpdateTextField({ clearFields: ["location"] }, {}, "location", {
        ...guards,
        userTexts: [plainMove, "remove the location"],
      }),
    ).toBeUndefined();
  });
});
