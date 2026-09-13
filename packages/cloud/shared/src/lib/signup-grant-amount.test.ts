/**
 * The opening-balance policy stays fixed across every runtime environment.
 * Explicit funding and promotion paths have their own independently tested ledgers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { isUntouchedSignupOpeningBalance, SIGNUP_CREDIT_POLICY } from "./signup-credits";

const originalInitialFreeCredits = process.env.INITIAL_FREE_CREDITS;

afterEach(() => {
  if (originalInitialFreeCredits === undefined) {
    delete process.env.INITIAL_FREE_CREDITS;
  } else {
    process.env.INITIAL_FREE_CREDITS = originalInitialFreeCredits;
  }
});

describe("signup credit policy", () => {
  test("opens every new organization without spendable signup credit", () => {
    expect(SIGNUP_CREDIT_POLICY).toEqual({
      automaticGrantUsd: 0,
      openingBalanceUsd: "0.00",
      legacyOpeningBalanceUsd: 0,
    });
  });

  test("cannot be changed by the retired environment override", () => {
    process.env.INITIAL_FREE_CREDITS = "99";
    expect(SIGNUP_CREDIT_POLICY.automaticGrantUsd).toBe(0);
    expect(SIGNUP_CREDIT_POLICY.openingBalanceUsd).toBe("0.00");
  });

  test("only permits an untouched zero balance to be discarded during account convergence", () => {
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 0, balanceRevision: 0 })).toBe(true);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 5, balanceRevision: 0 })).toBe(false);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 2, balanceRevision: 0 })).toBe(false);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 0, balanceRevision: 1 })).toBe(false);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 5, balanceRevision: 1 })).toBe(false);
  });
});
