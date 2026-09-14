/**
 * Display helpers for Agent pricing.
 * Imports from the canonical agent-pricing.ts constants — never hardcodes rates.
 */

import { AGENT_PRICING } from "./agent-pricing.js";

// ── Derived display values ──────────────────────────────────────

/** Monthly cost for a running agent (24/7). */
export const MONTHLY_RUNNING_COST =
  Math.round(AGENT_PRICING.RUNNING_HOURLY_RATE * 24 * 30 * 100) / 100;

/** Monthly cost for an idle agent. */
export const MONTHLY_IDLE_COST =
  Math.round(AGENT_PRICING.IDLE_HOURLY_RATE * 24 * 30 * 100) / 100; // ~$1.80

// ── Formatting helpers ──────────────────────────────────────────

/** Format a dollar amount for display. */
export function formatUSD(amount: number, decimals = 2): string {
  return `$${amount.toFixed(decimals)}`;
}

/** Keep fractional cents visible, up to the billing ledger's six-decimal precision. */
export function formatHourlyRate(rate: number): string {
  const amount = rate.toFixed(6).replace(/(\.\d{2}.*?)0+$/, "$1");
  return `$${amount}/hr`;
}

/** Format monthly estimate as "~$X.XX/mo". */
export function formatMonthlyEstimate(hourlyRate: number): string {
  const monthly = Math.round(hourlyRate * 24 * 30 * 100) / 100;
  return `~${formatUSD(monthly)}/mo`;
}

// ── Cost estimation ─────────────────────────────────────────────

/**
 * Estimate how many hours a credit balance can sustain given
 * a certain number of running and idle agents.
 */
export function estimateHoursRemaining(
  balance: number,
  runningAgents: number,
  idleAgents: number,
): number | null {
  const hourlyBurn =
    runningAgents * AGENT_PRICING.RUNNING_HOURLY_RATE +
    idleAgents * AGENT_PRICING.IDLE_HOURLY_RATE;

  if (hourlyBurn <= 0) return null;
  return Math.floor(balance / hourlyBurn);
}

/**
 * Format hours into a human-readable duration ("3d 12h", "14h", etc.)
 */
export function formatDuration(hours: number): string {
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return `${hours}h`;
}

/**
 * Calculate credit pack savings percentage.
 */
export function packSavingsPercent(
  priceCents: number,
  credits: number,
): number {
  const price = priceCents / 100;
  if (credits <= 0 || price >= credits) return 0;
  return Math.round(((credits - price) / credits) * 100);
}
