/**
 * Exercises agent credit gates with deterministic repository fixtures, including
 * corrupt Postgres NUMERIC values and the dedicated-hosting runway threshold.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const findById = mock();

mock.module("../../../db/repositories", () => ({
  organizationsRepository: {
    findById,
  },
}));

const loggerError = mock();

mock.module("../../utils/logger", () => ({
  logger: {
    error: loggerError,
    warn: mock(),
    info: mock(),
    debug: mock(),
  },
}));

const {
  checkAgentCreditGate,
  checkAgentTierUpgradeCreditGate,
  parseGateCreditBalance,
  CorruptCreditBalanceError,
} = await import("../agent-billing-gate");

beforeEach(() => {
  findById.mockReset();
  loggerError.mockReset();
});

describe("parseGateCreditBalance", () => {
  test("accepts plain decimal strings (driver NUMERIC shape)", () => {
    expect(parseGateCreditBalance("12.34")).toBe(12.34);
    expect(parseGateCreditBalance("0")).toBe(0);
    expect(parseGateCreditBalance("0.00")).toBe(0);
    expect(parseGateCreditBalance("-3.5")).toBe(-3.5);
    expect(parseGateCreditBalance(".25")).toBe(0.25);
  });

  test("accepts finite numbers", () => {
    expect(parseGateCreditBalance(7.5)).toBe(7.5);
    expect(parseGateCreditBalance(0)).toBe(0);
  });

  test("throws on corrupt values instead of producing NaN", () => {
    for (const raw of ["NaN", "Infinity", "-Infinity", "", "   ", "1e3", "0x10", "12,34", "abc"]) {
      expect(() => parseGateCreditBalance(raw)).toThrow(CorruptCreditBalanceError);
    }
    expect(() => parseGateCreditBalance(Number.NaN)).toThrow(CorruptCreditBalanceError);
    expect(() => parseGateCreditBalance(Number.POSITIVE_INFINITY)).toThrow(
      CorruptCreditBalanceError,
    );
    expect(() => parseGateCreditBalance(null)).toThrow(CorruptCreditBalanceError);
    expect(() => parseGateCreditBalance(undefined)).toThrow(CorruptCreditBalanceError);
    expect(() => parseGateCreditBalance({})).toThrow(CorruptCreditBalanceError);
  });
});

describe("checkAgentCreditGate", () => {
  test.each([
    ["0.299999", false],
    ["0.300000", true],
  ] as const)(
    "the initial two-hour funding threshold admits balance %s: %s",
    async (balance, allowed) => {
      findById.mockResolvedValue({ credit_balance: balance });
      expect((await checkAgentCreditGate("org-exact-threshold")).allowed).toBe(allowed);
    },
  );

  test("allows an org with a healthy balance above the minimum deposit", async () => {
    findById.mockResolvedValue({ credit_balance: "25.00" });

    const result = await checkAgentCreditGate("org-healthy");

    expect(result.allowed).toBe(true);
    expect(result.balance).toBe(25);
    expect(result.error).toBeUndefined();
  });

  test("denies an org below the minimum deposit with a funding message", async () => {
    findById.mockResolvedValue({ credit_balance: "0.05" });

    const result = await checkAgentCreditGate("org-broke");

    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0.05);
    expect(result.error).toContain("Insufficient credits");
  });

  test("explicit zero balance is a legit domain value and denies (not corrupt)", async () => {
    findById.mockResolvedValue({ credit_balance: "0.00" });

    const result = await checkAgentCreditGate("org-zero");

    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.error).toContain("Insufficient credits");
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("REGRESSION: corrupt 'NaN' balance FAILS CLOSED, never { allowed: true, balance: NaN }", async () => {
    findById.mockResolvedValue({ credit_balance: "NaN" });

    const result = await checkAgentCreditGate("org-corrupt");

    expect(result.allowed).toBe(false);
    expect(Number.isNaN(result.balance)).toBe(false);
    expect(result.error).toContain("Unable to verify credit balance");
    // Observable, distinct corrupt-value log naming the org
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [message, context] = loggerError.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("Corrupt credit_balance");
    expect(context.organizationId).toBe("org-corrupt");
    expect(context.rawValue).toBe("NaN");
  });

  test("corrupt empty-string balance also fails closed", async () => {
    findById.mockResolvedValue({ credit_balance: "" });

    const result = await checkAgentCreditGate("org-empty");

    expect(result.allowed).toBe(false);
    expect(result.error).toContain("Unable to verify credit balance");
  });

  test("zero balance + withheld welcome bonus recorded on settings → reason attached", async () => {
    findById.mockResolvedValue({
      credit_balance: "0.00",
      settings: {
        welcomeBonusWithheld: {
          reason: "ip_daily_cap",
          message:
            "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.",
        },
      },
    });

    const result = await checkAgentCreditGate("org-capped-signup");

    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.welcomeBonusWithheldReason).toBe("ip_daily_cap");
    expect(result.welcomeBonusWithheldMessage).toContain("daily free-credit limit");
  });

  test("topped-up org (balance > 0) does NOT resurface the stale withheld record", async () => {
    findById.mockResolvedValue({
      credit_balance: "0.05",
      settings: { welcomeBonusWithheld: { reason: "ip_daily_cap" } },
    });

    const result = await checkAgentCreditGate("org-topped-up");

    expect(result.allowed).toBe(false);
    expect(result.welcomeBonusWithheldReason).toBeUndefined();
    expect(result.welcomeBonusWithheldMessage).toBeUndefined();
  });

  test("malformed withheld settings shapes are ignored (fail-closed messaging)", async () => {
    for (const settings of [
      undefined,
      null,
      {},
      { welcomeBonusWithheld: true },
      { welcomeBonusWithheld: { reason: "not_a_reason" } },
      { welcomeBonusWithheld: { message: "no reason" } },
    ]) {
      findById.mockResolvedValue({ credit_balance: "0.00", settings });
      const result = await checkAgentCreditGate("org-odd-settings");
      expect(result.allowed).toBe(false);
      expect(result.welcomeBonusWithheldReason).toBeUndefined();
    }
  });

  test("missing org denies without a corrupt-value log", async () => {
    findById.mockResolvedValue(null);

    const result = await checkAgentCreditGate("org-missing");

    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.error).toBe("Organization not found");
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("repository failure still fails closed (pre-existing behavior preserved)", async () => {
    findById.mockRejectedValue(new Error("db down"));

    const result = await checkAgentCreditGate("org-db-down");

    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.error).toContain("Unable to verify credit balance");
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [message] = loggerError.mock.calls[0] as [string];
    expect(message).toContain("Failed to check credits");
  });
});

describe("checkAgentTierUpgradeCreditGate", () => {
  test("requires the dedicated-hosting runway rather than the create minimum", async () => {
    findById.mockResolvedValue({ credit_balance: "0.50" });

    const result = await checkAgentTierUpgradeCreditGate("org-short-runway");

    expect(result.allowed).toBe(false);
    expect(result.balance).toBe(0.5);
    expect(result.error).toContain("3 days of hosting");
    expect(result.error).toContain("$10.30");
  });

  test("allows an upgrade at the dedicated-hosting threshold", async () => {
    findById.mockResolvedValue({ credit_balance: "10.80" });

    const result = await checkAgentTierUpgradeCreditGate("org-funded-upgrade");

    expect(result).toEqual({ allowed: true, balance: 10.8 });
  });
});
