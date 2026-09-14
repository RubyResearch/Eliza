/**
 * Agent billing gate — pre-provisioning credit check.
 *
 * Ensures an organization has at least the minimum running balance before
 * allowing agent creation, provisioning, or resume.
 */

import { organizationsRepository } from "../../db/repositories";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import {
  readWelcomeBonusWithheldSettings,
  type SignupGrantWithheldReason,
} from "./signup-grant-guard";

export interface CreditGateResult {
  allowed: boolean;
  balance: number;
  error?: string;
  /**
   * Set only for organizations carrying historical welcome-credit withholding
   * metadata. New accounts start at zero and never write this legacy state.
   */
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
}

/**
 * Thrown when an organization's stored credit_balance cannot be parsed into a
 * finite number. `'NaN'::numeric` is a valid Postgres NUMERIC value, so a
 * corrupt row reads back as the string "NaN"; without a fail-closed boundary
 * that read poisons the spend gate below (see parseGateCreditBalance).
 */
export class CorruptCreditBalanceError extends Error {
  readonly rawValue: string;

  constructor(rawValue: unknown) {
    const printable =
      rawValue === null ? "null" : rawValue === undefined ? "undefined" : String(rawValue);
    super(`Corrupt organizations.credit_balance read: ${JSON.stringify(printable)}`);
    this.name = "CorruptCreditBalanceError";
    this.rawValue = printable;
  }
}

/** Plain signed decimal only — rejects "1e3", "0x10", "NaN", "Infinity", "". */
const PLAIN_DECIMAL_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

/**
 * Fail-closed boundary for the organizations.credit_balance NUMERIC read.
 *
 * The previous bare `Number(org.credit_balance)` FAILED OPEN on a corrupt
 * row: `Number("NaN") === NaN`, and `NaN <= MINIMUM_DEPOSIT` is `false`, so
 * the gate returned `{ allowed: true, balance: NaN }` — authorizing agent
 * creation/provisioning/resume against an unverifiable balance, despite the
 * catch-path comment claiming this gate fails closed.
 *
 * Accepts a finite number or a plain signed decimal string (the shape the
 * Postgres driver returns for NUMERIC). Explicit zero and negative
 * (overdrawn) balances are legitimate domain values. Everything else throws.
 * error-policy:J1
 */
export function parseGateCreditBalance(raw: unknown): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new CorruptCreditBalanceError(raw);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed !== "" && PLAIN_DECIMAL_RE.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    throw new CorruptCreditBalanceError(raw);
  }
  throw new CorruptCreditBalanceError(raw);
}

/**
 * Shared fail-closed core for the balance gates below: read the org's stored
 * balance, parse it defensively, and deny when it does not clear
 * `minimumBalance` (with a threshold-specific user-facing message).
 */
async function runCreditGate(
  organizationId: string,
  minimumBalance: number,
  insufficientMessage: (balance: number) => string,
): Promise<CreditGateResult> {
  try {
    const org = await organizationsRepository.findById(organizationId);
    if (!org) {
      return {
        allowed: false,
        balance: 0,
        error: "Organization not found",
      };
    }

    const balance = parseGateCreditBalance(org.credit_balance);

    if (balance < minimumBalance) {
      // A successful credit transaction removes this marker atomically with
      // its balance increase. If it remains at zero, the org has never been
      // funded since signup and the original withheld reason is still honest.
      const withheld = balance <= 0 ? readWelcomeBonusWithheldSettings(org.settings) : null;
      return {
        allowed: false,
        balance,
        error: insufficientMessage(balance),
        ...(withheld
          ? {
              welcomeBonusWithheldReason: withheld.reason,
              ...(withheld.message ? { welcomeBonusWithheldMessage: withheld.message } : {}),
            }
          : {}),
      };
    }

    return { allowed: true, balance };
  } catch (error) {
    if (error instanceof CorruptCreditBalanceError) {
      // error-policy:J1 — corrupt stored money value: deny, surface for repair.
      logger.error("[agent-billing-gate] Corrupt credit_balance — failing closed", {
        organizationId,
        rawValue: error.rawValue,
      });
      return {
        allowed: false,
        balance: 0,
        error:
          "Unable to verify credit balance for this organization. Please contact support before creating or resuming agents.",
      };
    }
    logger.error("[agent-billing-gate] Failed to check credits", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed — don't allow provisioning if we can't verify credits
    return {
      allowed: false,
      balance: 0,
      error: "Unable to verify credit balance. Please try again.",
    };
  }
}

/**
 * Check whether an organization has sufficient credits for Eliza agent operations.
 *
 * Returns `{ allowed: true }` if `credit_balance >= MINIMUM_DEPOSIT`,
 * otherwise returns a user-facing error message directing them to add funds.
 *
 * Fails CLOSED on a corrupt stored balance (distinct observable log) and on
 * any repository/transport failure — never authorizes provisioning against a
 * balance it could not verify.
 */
export async function checkAgentCreditGate(organizationId: string): Promise<CreditGateResult> {
  return runCreditGate(organizationId, AGENT_PRICING.MINIMUM_DEPOSIT, (balance) => {
    const deficit = Math.max(AGENT_PRICING.MINIMUM_DEPOSIT - balance, 0.01);
    return `Insufficient credits. A balance of at least $${AGENT_PRICING.MINIMUM_DEPOSIT.toFixed(2)} is required to create or run Eliza agents. Please add at least $${deficit.toFixed(2)} to your account at /cloud/billing.`;
  });
}

/**
 * Stricter gate for the shared→dedicated tier upgrade (#15355): a dedicated
 * agent burns hosting credits continuously, so the upgrade requires enough
 * balance for {@link AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS} days of running
 * cost instead of the bare MINIMUM_DEPOSIT. Same fail-closed semantics and
 * result shape as {@link checkAgentCreditGate}, so the canonical 402 body
 * (`insufficientCredits402`) works unchanged.
 */
export async function checkAgentTierUpgradeCreditGate(
  organizationId: string,
): Promise<CreditGateResult> {
  const minimum = AGENT_PRICING.UPGRADE_MINIMUM_BALANCE;
  return runCreditGate(organizationId, minimum, (balance) => {
    const deficit = Math.max(minimum - balance, 0.01);
    return `Insufficient credits to upgrade. A dedicated agent costs $${AGENT_PRICING.DAILY_RUNNING_COST.toFixed(2)}/day of hosting, and upgrading requires a balance of at least $${minimum.toFixed(2)} (${AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS} days of hosting). Please add at least $${deficit.toFixed(2)} to your account at /cloud/billing.`;
  });
}
