/**
 * Canonical opening-balance policy for every Cloud account-creation path.
 *
 * Account creation grants no spendable credit. Purchased top-ups, explicit
 * promotions, referrals, and historical balances use separate ledger paths.
 */

export const SIGNUP_CREDIT_POLICY = {
  automaticGrantUsd: 0,
  openingBalanceUsd: "0.00",
  legacyOpeningBalanceUsd: 0,
} as const;

/**
 * Identifies an opening balance that has never been debited or topped up.
 * Historical positive balances remain value-bearing and must not be discarded
 * when a provisional account joins or converges into another organization.
 */
export function isUntouchedSignupOpeningBalance(input: {
  balanceUsd: number;
  balanceRevision: number;
}): boolean {
  return (
    input.balanceRevision === 0 &&
    (input.balanceUsd === SIGNUP_CREDIT_POLICY.legacyOpeningBalanceUsd ||
      input.balanceUsd === SIGNUP_CREDIT_POLICY.automaticGrantUsd)
  );
}
