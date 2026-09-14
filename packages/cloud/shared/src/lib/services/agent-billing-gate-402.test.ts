/** Exercises canonical agent billing 402 responses with deterministic service fixtures. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import { insufficientCredits402, insufficientCreditsBody } from "./agent-billing-gate-402";

describe("insufficientCreditsBody", () => {
  test("builds the canonical 402 wire shape — exact fields, nothing else", () => {
    const body = insufficientCreditsBody({
      balance: 0.02,
      error: "Insufficient credits. Please add funds.",
    });

    expect(body).toStrictEqual({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits. Please add funds.",
      requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
      currentBalance: 0.02,
    });
  });

  test("falls back to a generic message when the gate result has no error", () => {
    const body = insufficientCreditsBody({ balance: 0 });

    expect(body.error).toBe("Insufficient credits");
    expect(body.success).toBe(false);
    expect(body.code).toBe("insufficient_credits");
  });

  test("reports the stricter balance enforced by a tier-upgrade gate", () => {
    const body = insufficientCreditsBody(
      { balance: 0.5, error: "Insufficient credits to upgrade." },
      { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
    );

    expect(body.requiredBalance).toBe(10.8);
    expect(body.currentBalance).toBe(0.5);
  });

  test("explains a zero balance caused by a withheld welcome bonus", () => {
    const body = insufficientCreditsBody(
      { balance: 0, error: "Insufficient credits" },
      {
        welcomeBonusWithheldReason: "ip_daily_cap",
        welcomeBonusWithheldMessage:
          "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.",
      },
    );

    expect(body).toStrictEqual({
      success: false,
      code: "insufficient_credits",
      error:
        "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.",
      requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
      currentBalance: 0,
      welcomeBonusWithheld: true,
      welcomeBonusWithheldReason: "ip_daily_cap",
    });
  });
});

describe("insufficientCreditsBody — gate-carried withheld reason", () => {
  test("uses the reason the credit gate read from the org's settings (no route plumbing)", () => {
    const body = insufficientCreditsBody({
      balance: 0,
      error: "Insufficient credits",
      welcomeBonusWithheldReason: "ip_daily_cap",
      welcomeBonusWithheldMessage:
        "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.",
    });

    expect(body.welcomeBonusWithheld).toBe(true);
    expect(body.welcomeBonusWithheldReason).toBe("ip_daily_cap");
    expect(body.error).toContain("daily free-credit limit");
  });

  test("explicit route context wins over the gate-carried reason", () => {
    const body = insufficientCreditsBody(
      {
        balance: 0,
        error: "Insufficient credits",
        welcomeBonusWithheldReason: "count_unavailable",
        welcomeBonusWithheldMessage: "gate message",
      },
      {
        welcomeBonusWithheldReason: "ip_daily_cap",
        welcomeBonusWithheldMessage: "route message",
      },
    );

    expect(body.welcomeBonusWithheldReason).toBe("ip_daily_cap");
    expect(body.error).toBe("route message");
  });

  test("positive balance suppresses the withheld explanation (stale record)", () => {
    const body = insufficientCreditsBody({
      balance: 0.05,
      error: "Insufficient credits.",
      welcomeBonusWithheldReason: "ip_daily_cap",
    });

    expect(body.welcomeBonusWithheld).toBeUndefined();
    expect(body.error).toBe("Insufficient credits.");
  });
});

describe("insufficientCredits402", () => {
  const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

  beforeEach(() => {
    warnSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockClear();
  });

  test("warns with the route's line + gate numbers and returns the canonical body", () => {
    const creditCheck = { balance: 0.05, error: "Insufficient credits." };

    const body = insufficientCredits402(
      creditCheck,
      "[agent-api] Resume blocked: insufficient credits",
      { agentId: "agent-1", orgId: "org-1" },
    );

    expect(body).toStrictEqual(insufficientCreditsBody(creditCheck));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[agent-api] Resume blocked: insufficient credits", {
      agentId: "agent-1",
      orgId: "org-1",
      balance: 0.05,
      required: AGENT_PRICING.MINIMUM_DEPOSIT,
    });
  });
});
