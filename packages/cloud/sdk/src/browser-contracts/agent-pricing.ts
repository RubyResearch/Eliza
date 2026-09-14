/**
 * Pricing constants for Eliza Cloud hosted agents (Docker-based).
 *
 * These agents run on dedicated Hetzner servers, not AWS ECS.
 * Pricing is hourly-based and billed by an hourly cron.
 *
 * Running agents:  $0.15/hour  (~$108 per 30 days)
 * Idle/stopped:    $0.0025/hour (~$1.80/month - snapshot storage)
 *
 * All amounts in USD.
 */

export const AGENT_PRICING = {
  // ── Hourly rates ──────────────────────────────────────────────────
  /** Cost per hour for a running agent. */
  RUNNING_HOURLY_RATE: 0.15,
  /** Minimum billed amount per successful activation, expressed at the running rate. */
  MINIMUM_ACTIVATION_HOURS: 2,
  get MINIMUM_ACTIVATION_CHARGE(): number {
    return (
      Math.round(
        this.RUNNING_HOURLY_RATE * this.MINIMUM_ACTIVATION_HOURS * 100,
      ) / 100
    );
  },
  /** Cost per hour for an idle/stopped agent (snapshot storage). */
  IDLE_HOURLY_RATE: 0.0025,

  // ── Derived daily rates (for display / logging) ───────────────────
  /** Daily cost for a running agent ($3.60/day). */
  get DAILY_RUNNING_COST(): number {
    return Math.round(this.RUNNING_HOURLY_RATE * 24 * 100) / 100;
  },
  /** Daily cost for an idle agent ($0.06/day). */
  get DAILY_IDLE_COST(): number {
    return Math.round(this.IDLE_HOURLY_RATE * 24 * 100) / 100;
  },

  // ── Thresholds ────────────────────────────────────────────────────
  /** Minimum credit balance required before creating, provisioning, or resuming an agent. */
  MINIMUM_DEPOSIT: 0.3,
  /**
   * Days of dedicated hosting a shared→dedicated tier upgrade must be able to
   * fund up front (#15355). Dedicated agents burn credits continuously, so the
   * upgrade gate demands a runway instead of the bare MINIMUM_DEPOSIT — an
   * upgrade that would run dry within hours is a worse product than no upgrade.
   */
  UPGRADE_MIN_HOSTING_DAYS: 3,
  /** Minimum credit balance required to upgrade a shared agent to dedicated ($10.80). */
  get UPGRADE_MINIMUM_BALANCE(): number {
    return (
      Math.round(
        this.DAILY_RUNNING_COST * this.UPGRADE_MIN_HOSTING_DAYS * 100,
      ) / 100
    );
  },
  /** Warn user when balance drops below this. */
  LOW_CREDIT_WARNING: 2.0,
  /** No unpaid grace: insufficient funds queue a stop immediately. */
  GRACE_PERIOD_HOURS: 0,
} as const;

/** Explicit acceptance of the tariff shown before a new paid Dedicated start. */
export const DEDICATED_COMPUTE_PRICE_HEADER = "X-Eliza-Dedicated-Price";

/** Version the policy as well as its amounts; callers must review changed terms. */
export function getDedicatedComputePriceAcceptance(): string {
  return `dedicated-compute-v1:USD:${AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6)}:${AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE.toFixed(6)}`;
}
