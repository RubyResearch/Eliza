/**
 * Pricing constants for Eliza Cloud hosted agents (Docker-based).
 *
 * These agents run on dedicated Hetzner servers, not AWS ECS.
 * Pricing is hourly-based and billed by an hourly cron.
 *
 * Running agents:  $0.01/hour  (~$7.20/month)
 * Idle/stopped:    $0.0025/hour (~$1.80/month - snapshot storage)
 *
 * All amounts in USD.
 */

export const AGENT_PRICING = {
  // ── Hourly rates ──────────────────────────────────────────────────
  /** Cost per hour for a running agent. */
  RUNNING_HOURLY_RATE: 0.01,
  /** Cost per hour for an idle/stopped agent (snapshot storage). */
  IDLE_HOURLY_RATE: 0.0025,

  // ── Derived daily rates (for display / logging) ───────────────────
  /** Daily cost for a running agent ($0.24/day). */
  get DAILY_RUNNING_COST(): number {
    return Math.round(this.RUNNING_HOURLY_RATE * 24 * 100) / 100;
  },
  /** Daily cost for an idle agent ($0.06/day). */
  get DAILY_IDLE_COST(): number {
    return Math.round(this.IDLE_HOURLY_RATE * 24 * 100) / 100;
  },

  // ── Thresholds ────────────────────────────────────────────────────
  /** Minimum credit balance required before creating, provisioning, or resuming an agent. */
  MINIMUM_DEPOSIT: 0.1,
  /**
   * Days of dedicated hosting a shared→dedicated tier upgrade must be able to
   * fund up front (#15355). Dedicated agents burn credits continuously, so the
   * upgrade gate demands a runway instead of the bare MINIMUM_DEPOSIT — an
   * upgrade that would run dry within hours is a worse product than no upgrade.
   */
  UPGRADE_MIN_HOSTING_DAYS: 3,
  /** Minimum credit balance required to upgrade a shared agent to dedicated ($0.72). */
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
